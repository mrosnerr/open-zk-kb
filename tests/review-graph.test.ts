import { describe, expect, it } from 'bun:test';
import type { ContextualLinkDocument, ContextualLinkReadResult } from '../src/link-health/types';
import { canonicalFingerprint } from '../src/review/fingerprint';
import {
  BUILTIN_GRAPH_RULES,
  GRAPH_RULE_METADATA,
  materializeGraphReview,
  planGraphFacts,
  type GraphFactKey,
  type GraphFacts,
  type GraphRule,
} from '../src/review/graph';
import { orderFactKeys } from '../src/review/graph-plan';

function document(id: string, title: string, tags: string[] = []): ContextualLinkDocument {
  return { id, title, kind: 'reference', status: 'fleeting', tags };
}

function readable(doc: ContextualLinkDocument, source: string): ContextualLinkReadResult {
  return { document: doc, ok: true, source };
}

const alpha = document('1000000000000001', 'Alpha', ['project:demo']);
const beta = document('1000000000000002', 'Beta', ['project:demo']);

const resolveKnown = (slug: string) => slug === beta.id
  ? { kind: 'document' as const, id: beta.id }
  : { kind: 'unresolved' as const };

describe('graph registry and planning', () => {
  it('preserves closed rule metadata and compatibility order', () => {
    expect(BUILTIN_GRAPH_RULES.map(rule => rule.id)).toEqual([
      'links.broken',
      'links.unlinked',
      'links.reciprocal-missing',
    ]);
    expect(GRAPH_RULE_METADATA.map(rule => rule.id)).toEqual(BUILTIN_GRAPH_RULES.map(rule => rule.id));
    expect(BUILTIN_GRAPH_RULES.map(({ profile, impact, basis }) => ({ profile, impact, basis }))).toEqual([
      { profile: 'links', impact: 'warning', basis: 'invariant' },
      { profile: 'links', impact: 'info', basis: 'heuristic' },
      { profile: 'links', impact: 'info', basis: 'heuristic' },
    ]);
  });

  it('rejects an unknown rule id, fact key, and dependency cycle', () => {
    expect(() => planGraphFacts(['links.unknown'])).toThrow('Unknown graph rule: links.unknown');
    const unknown = {
      'contextual-links': ['mystery' as GraphFactKey],
      'resolved-links': [],
      'graph-edges': [],
      'document-applicability': [],
    } satisfies Readonly<Record<GraphFactKey, readonly GraphFactKey[]>>;
    expect(() => orderFactKeys(['contextual-links'], unknown)).toThrow('Unknown graph fact key: mystery');
    const cyclic = {
      'contextual-links': ['resolved-links'],
      'resolved-links': ['contextual-links'],
      'graph-edges': [],
      'document-applicability': [],
    } satisfies Readonly<Record<GraphFactKey, readonly GraphFactKey[]>>;
    expect(() => orderFactKeys(['contextual-links'], cyclic)).toThrow('Graph fact dependency cycle at: contextual-links');
  });

  it('rejects an inherited prototype fact key, an empty rule id, and an empty rule selection', () => {
    const declared = {
      'contextual-links': [],
      'resolved-links': [],
      'graph-edges': [],
      'document-applicability': [],
    } satisfies Readonly<Record<GraphFactKey, readonly GraphFactKey[]>>;
    expect(() => orderFactKeys(['toString' as GraphFactKey], declared)).toThrow('Unknown graph fact key: toString');
    expect(() => orderFactKeys(['contextual-links'], { ...declared, 'contextual-links': ['constructor' as GraphFactKey] }))
      .toThrow('Unknown graph fact key: constructor');
    expect(() => planGraphFacts([''])).toThrow('Unknown graph rule: ');
    expect(() => planGraphFacts([])).toThrow('No graph rules requested');
  });

  it('materializes only the selected provider closure in deterministic order', () => {
    expect(planGraphFacts(['links.broken']).providerKeys).toEqual(['contextual-links', 'resolved-links']);
    expect(planGraphFacts(['links.unlinked']).providerKeys).toEqual(['contextual-links', 'resolved-links', 'graph-edges']);
    expect(planGraphFacts(['links.reciprocal-missing']).providerKeys).toEqual([
      'contextual-links', 'resolved-links', 'graph-edges', 'document-applicability',
    ]);
  });
});

describe('graph materialization and formal findings', () => {
  it('resolves each distinct target once and preserves occurrence identity and fingerprints', () => {
    let calls = 0;
    const source = `[[missing]] [[missing]] [[${beta.id}]]`;
    const result = materializeGraphReview([readable(alpha, source), readable(beta, '')], slug => {
      calls++;
      return resolveKnown(slug);
    });

    expect(calls).toBe(2);
    const broken = result.review.groups[0].findings;
    expect(broken).toHaveLength(2);
    expect(broken[0]).toMatchObject({
      ruleId: 'links.broken', ruleVersion: 1, impact: 'warning', basis: 'invariant',
      primary: { id: alpha.id, role: 'primary' },
      evidence: [
        { label: 'sourceTitle', value: 'Alpha' },
        { label: 'target', value: 'missing' },
        { label: 'line', value: 1 },
      ],
      identity: [alpha.id, 'missing', 0],
    });
    expect(broken[0].fingerprint).toBe(canonicalFingerprint('links.broken', [alpha.id, 'missing', 0]));
    expect(broken[0].fingerprint).not.toBe(broken[1].fingerprint);
    expect(broken[0].resolutions).toBeUndefined();
  });

  it('uses logical subjects for unlinked and ordered source-target identity for reciprocal findings', () => {
    const lone = document('1000000000000003', 'Lone');
    const result = materializeGraphReview([readable(alpha, `[[${beta.id}]]`), readable(beta, ''), readable(lone, '')], resolveKnown);
    const unlinked = result.review.groups.find(group => group.ruleId === 'links.unlinked')?.findings[0];
    const reciprocal = result.review.groups.find(group => group.ruleId === 'links.reciprocal-missing')?.findings[0];
    expect(unlinked).toMatchObject({ primary: { id: lone.id }, identity: [lone.id], impact: 'info', basis: 'heuristic' });
    expect(reciprocal).toMatchObject({
      primary: { id: alpha.id }, related: [{ id: beta.id, role: 'related' }], identity: [alpha.id, beta.id],
    });
  });

  it('preserves provider edge order for reciprocal findings instead of re-sorting by title', () => {
    const zulu = document('1000000000000004', 'Zulu');
    const middle = document('1000000000000005', 'Middle');
    const anchor = document('1000000000000006', 'Anchor');
    const resolve = (slug: string) => [zulu, middle, anchor].some(doc => doc.id === slug)
      ? { kind: 'document' as const, id: slug }
      : { kind: 'unresolved' as const };
    // Authored order is Zulu -> Middle -> Anchor; alphabetical title order would be the reverse.
    const result = materializeGraphReview([
      readable(zulu, `[[${middle.id}]]`),
      readable(middle, `[[${anchor.id}]]`),
      readable(anchor, ''),
    ], resolve, ['links.reciprocal-missing']);
    expect(result.review.groups[0].findings.map(finding => finding.primary.id)).toEqual([zulu.id, middle.id]);
  });

  it('treats vault-target as a valid discriminated target without creating an edge or broken finding', () => {
    const result = materializeGraphReview([readable(alpha, '[[unindexed]]')], () => ({ kind: 'vault-target' }), ['links.broken']);
    expect(result.facts.resolvedLinks?.occurrences[0].resolution).toEqual({ kind: 'vault-target' });
    expect(result.review.totals).toEqual({ 'links.broken': 0 });
  });

  it('keeps conservative rule-only policy for failures and publication edges', () => {
    const failed = document('1000000000000003', 'Failed');
    const global = document(beta.id, beta.title, ['scope:global']);
    const local = document(alpha.id, alpha.title, ['project:demo']);
    const result = materializeGraphReview([
      readable(local, `[[${global.id}]] [[missing]]`),
      readable(global, ''),
      { document: failed, ok: false, reason: '/private/error' },
    ], resolveKnown);
    expect(result.review.totals).toEqual({ 'links.broken': 1, 'links.unlinked': 0, 'links.reciprocal-missing': 0 });
    expect(result.incompleteGraph).toBe(true);
    expect(result.failures).toEqual([{ id: failed.id, title: failed.title }]);
    expect(JSON.stringify(result)).not.toContain('/private/error');
  });

  it('passes each rule only its declared, deeply frozen fact slice', () => {
    const rule = BUILTIN_GRAPH_RULES[0];
    const original = rule.evaluate;
    let received: GraphFacts | undefined;
    (rule as { evaluate: GraphRule['evaluate'] }).evaluate = input => { received = input; return []; };
    try {
      materializeGraphReview([readable(alpha, '[[missing]]')], resolveKnown, ['links.broken']);
      expect(Object.keys(received ?? {})).toEqual(['resolvedLinks']);
      expect(Object.isFrozen(received)).toBe(true);
      expect(Object.isFrozen(received?.resolvedLinks?.occurrences)).toBe(true);
    } finally {
      (rule as { evaluate: GraphRule['evaluate'] }).evaluate = original;
    }
  });
});

describe('graph result isolation and determinism', () => {
  it('is JSON-byte deterministic with stable group order and totals', () => {
    const input = [readable(alpha, `[[${beta.id}]] [[missing]]`), readable(beta, '')];
    const first = materializeGraphReview(input, resolveKnown);
    const second = materializeGraphReview(input, resolveKnown);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.review.groups.map(group => group.ruleId)).toEqual([
      'links.broken', 'links.unlinked', 'links.reciprocal-missing',
    ]);
    expect(first.review.totals).toEqual({ 'links.broken': 1, 'links.unlinked': 0, 'links.reciprocal-missing': 1 });
  });

  it('copies resolver-owned outcomes before freezing facts', () => {
    const resolution = { kind: 'document' as const, id: beta.id };
    const result = materializeGraphReview(
      [readable(alpha, `[[${beta.id}]]`), readable(beta, '')],
      () => resolution,
      ['links.broken'],
    );

    expect(Object.isFrozen(resolution)).toBe(false);
    resolution.id = 'caller-mutated';
    expect(result.facts.resolvedLinks?.occurrences[0].resolution).toEqual({ kind: 'document', id: beta.id });
    expect(Object.isFrozen(result.facts.resolvedLinks?.occurrences[0].resolution)).toBe(true);
  });

  it('deep-freezes outputs without freezing or retaining caller-owned values', () => {
    const tags = ['project:demo'];
    const callerDocument = document(alpha.id, alpha.title, tags);
    const input = [readable(callerDocument, '[[missing]]')];
    const scope = { kind: 'project' as const, project: 'demo', client: 'pi' };
    const result = materializeGraphReview(input, resolveKnown, undefined, scope);

    tags.push('mutated');
    input.push(readable(beta, ''));
    scope.project = 'changed';
    expect(result.facts.contextualLinks?.documents[0].tags).toEqual(['project:demo']);
    expect(result.review.scope).toEqual({ kind: 'project', project: 'demo', client: 'pi' });
    expect(Object.isFrozen(tags)).toBe(false);
    expect(Object.isFrozen(scope)).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.facts.contextualLinks?.documents[0].tags)).toBe(true);
    expect(Object.isFrozen(result.review.groups[0].findings[0].evidence[0])).toBe(true);
    expect(() => (result.review.groups as unknown as unknown[]).push({})).toThrow();
  });
});
