// tests/review-graph.test.ts - Formal contextual graph rules: metadata,
// basis/impact, fingerprint stability, deterministic ordering, logical
// identity, and deep-freeze isolation. See src/review/graph.ts.
import { describe, expect, it } from 'bun:test';
import {
  BUILTIN_GRAPH_RULES,
  GRAPH_RULE_METADATA,
  evaluateGraphReview,
  type GraphFacts,
  type GraphRule,
} from '../src/review/graph';
import { canonicalFingerprint } from '../src/review/fingerprint';

function facts(overrides: Partial<GraphFacts> = {}): GraphFacts {
  return { broken: [], unlinked: [], oneWay: [], ...overrides };
}

const brokenOccurrence = {
  sourceId: '2026072500000001',
  sourceTitle: 'Alpha',
  brokenTarget: 'missing-target',
  line: 5,
  offset: 42,
};

const isolatedNote = {
  id: '2026072500000002',
  title: 'Lone',
  kind: 'reference' as const,
  status: 'fleeting' as const,
  tags: ['project:demo'],
};

const edge = {
  sourceId: '2026072500000003',
  sourceTitle: 'Source',
  targetId: '2026072500000004',
  targetTitle: 'Target',
};

describe('graph review: registry metadata', () => {
  it('declares three closed rules with the compatibility rule-id order', () => {
    expect(BUILTIN_GRAPH_RULES.map(r => r.id)).toEqual([
      'links.broken',
      'links.unlinked',
      'links.reciprocal-missing',
    ]);
    expect(GRAPH_RULE_METADATA.map(r => r.id)).toEqual(BUILTIN_GRAPH_RULES.map(r => r.id));
    for (const rule of BUILTIN_GRAPH_RULES) expect(rule.profile).toBe('links');
  });

  it('marks broken invariant/warning and the advisory rules info/heuristic', () => {
    const byId = new Map(BUILTIN_GRAPH_RULES.map(r => [r.id, r]));
    expect(byId.get('links.broken')).toMatchObject({ impact: 'warning', basis: 'invariant' });
    expect(byId.get('links.unlinked')).toMatchObject({ impact: 'info', basis: 'heuristic' });
    expect(byId.get('links.reciprocal-missing')).toMatchObject({ impact: 'info', basis: 'heuristic' });
  });
});

describe('graph review: finding shape and identity', () => {
  it('emits links.broken with source, target, one-based line, and occurrence-stable identity', () => {
    const result = evaluateGraphReview(facts({ broken: [brokenOccurrence] }), { ruleIds: ['links.broken'] });
    const finding = result.groups[0].findings[0];
    expect(finding.ruleId).toBe('links.broken');
    expect(finding.ruleVersion).toBe(1);
    expect(finding.impact).toBe('warning');
    expect(finding.basis).toBe('invariant');
    expect(finding.primary.id).toBe(brokenOccurrence.sourceId);
    expect(finding.evidence).toEqual([
      { label: 'sourceTitle', value: 'Alpha' },
      { label: 'target', value: 'missing-target' },
      { label: 'line', value: 5 },
    ]);
    expect(finding.identity).toEqual([brokenOccurrence.sourceId, 'missing-target', 42]);
    expect(finding.fingerprint).toBe(canonicalFingerprint('links.broken', [brokenOccurrence.sourceId, 'missing-target', 42]));
    expect(finding.resolutions).toBeUndefined();
  });

  it('keeps repeated broken occurrences of the same target distinct by offset', () => {
    const second = { ...brokenOccurrence, offset: 99 };
    const result = evaluateGraphReview(facts({ broken: [brokenOccurrence, second] }), { ruleIds: ['links.broken'] });
    const fingerprints = result.groups[0].findings.map(f => f.fingerprint);
    expect(new Set(fingerprints).size).toBe(2);
  });

  it('emits links.unlinked as info/heuristic with the isolated note as logical subject', () => {
    const result = evaluateGraphReview(facts({ unlinked: [isolatedNote] }), { ruleIds: ['links.unlinked'] });
    const finding = result.groups[0].findings[0];
    expect(finding.impact).toBe('info');
    expect(finding.basis).toBe('heuristic');
    expect(finding.primary.id).toBe(isolatedNote.id);
    expect(finding.identity).toEqual([isolatedNote.id]);
  });

  it('emits links.reciprocal-missing with an ordered source-target pair', () => {
    const result = evaluateGraphReview(facts({ oneWay: [edge] }), { ruleIds: ['links.reciprocal-missing'] });
    const finding = result.groups[0].findings[0];
    expect(finding.impact).toBe('info');
    expect(finding.basis).toBe('heuristic');
    expect(finding.primary.id).toBe(edge.sourceId);
    expect(finding.related?.[0]?.id).toBe(edge.targetId);
    expect(finding.identity).toEqual([edge.sourceId, edge.targetId]);
  });
});

describe('graph review: determinism and selection', () => {
  const all = facts({ broken: [brokenOccurrence], unlinked: [isolatedNote], oneWay: [edge] });

  it('produces identical groups, fingerprints, totals, and order across repeated evaluation', () => {
    const first = evaluateGraphReview(all);
    const second = evaluateGraphReview(all);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.groups.map(g => g.ruleId)).toEqual(['links.broken', 'links.unlinked', 'links.reciprocal-missing']);
    expect(first.totals).toEqual({ 'links.broken': 1, 'links.unlinked': 1, 'links.reciprocal-missing': 1 });
  });

  it('selects only the requested rule ids', () => {
    const result = evaluateGraphReview(all, { ruleIds: ['links.unlinked'] });
    expect(result.groups.map(g => g.ruleId)).toEqual(['links.unlinked']);
  });
});

describe('graph review: deep-freeze isolation', () => {
  it('freezes findings, evidence, subjects, groups, and totals', () => {
    const result = evaluateGraphReview(facts({ broken: [brokenOccurrence], oneWay: [edge] }));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.groups)).toBe(true);
    expect(Object.isFrozen(result.totals)).toBe(true);
    const brokenGroup = result.groups.find(g => g.ruleId === 'links.broken');
    if (!brokenGroup) throw new Error('missing broken group');
    const finding = brokenGroup.findings[0];
    expect(Object.isFrozen(finding)).toBe(true);
    expect(Object.isFrozen(finding.evidence)).toBe(true);
    expect(Object.isFrozen(finding.evidence[0])).toBe(true);
    expect(Object.isFrozen(finding.primary)).toBe(true);
    expect(() => (finding.evidence as { label: string }[]).push({ label: 'x' })).toThrow();
  });

  it('does not let source-array mutation after evaluation alter the result', () => {
    const source = [{ ...brokenOccurrence }];
    const result = evaluateGraphReview(facts({ broken: source }), { ruleIds: ['links.broken'] });
    source.push({ ...brokenOccurrence, offset: 1000 });
    source[0].brokenTarget = 'mutated';
    expect(result.groups[0].total).toBe(1);
    expect(result.groups[0].findings[0].identity).toEqual([brokenOccurrence.sourceId, 'missing-target', 42]);
  });

  it('copies scope before freezing the returned result', () => {
    const scope = { kind: 'project' as const, project: 'demo', client: 'pi' };
    const result = evaluateGraphReview(facts(), { scope });
    expect(result.scope).toEqual(scope);
    expect(result.scope).not.toBe(scope);
    expect(Object.isFrozen(result.scope)).toBe(true);
    expect(Object.isFrozen(scope)).toBe(false);
  });
});

describe('graph review: rule input boundary', () => {
  it('passes each rule a copied, deeply frozen graph-fact snapshot', () => {
    const rule = BUILTIN_GRAPH_RULES[0];
    const originalEvaluate = rule.evaluate;
    let received: GraphFacts | undefined;
    (rule as { evaluate: GraphRule['evaluate'] }).evaluate = input => {
      received = input;
      return [];
    };
    try {
      const source = facts({ broken: [{ ...brokenOccurrence }], unlinked: [{ ...isolatedNote, tags: [...isolatedNote.tags] }] });
      evaluateGraphReview(source, { ruleIds: ['links.broken'] });
      expect(received).toBeDefined();
      if (!received) throw new Error('rule did not receive graph facts');
      expect(received).not.toBe(source);
      expect(Object.isFrozen(received)).toBe(true);
      expect(Object.isFrozen(received.broken)).toBe(true);
      expect(Object.isFrozen(received.broken[0])).toBe(true);
      expect(Object.isFrozen(received.unlinked)).toBe(true);
      expect(Object.isFrozen(received.unlinked[0])).toBe(true);
      expect(Object.isFrozen(received.unlinked[0].tags)).toBe(true);
      expect(Object.isFrozen(source)).toBe(false);
    } finally {
      (rule as { evaluate: GraphRule['evaluate'] }).evaluate = originalEvaluate;
    }
  });
});
