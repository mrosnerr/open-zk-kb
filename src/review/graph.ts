// graph.ts - Closed built-in graph-rule profile for the internal
// vault-review core.
//
// The per-note evaluator in `registry.ts` judges one `NoteFacts` row at a
// time. Contextual link-health instead materializes one immutable graph
// snapshot (scan totals, broken occurrences, isolated notes, deduplicated
// missing-reciprocal edges); this module evaluates that snapshot through
// three closed built-in rules using the same `finalizeFinding()`,
// fingerprint, grouping, and deterministic-order contracts as
// `evaluateReview()`. It owns no filesystem, repository, database, parser,
// resolver, clock, telemetry, or mutation capability — rules receive only
// frozen plain graph facts. See src/review/README.md.

import type {
  ContextualBrokenFinding,
  ContextualOneWayFinding,
  ContextualUnlinkedFinding,
} from '../link-health/types.js';
import { finalizeFinding } from './registry.js';
import type {
  EvaluationResult,
  Finding,
  FindingDraft,
  FindingGroup,
  ReviewScope,
  RuleMetadata,
} from './types.js';

/**
 * The immutable graph facts a graph rule may read. Restricted to the three
 * graph-fact collections so rules never see a reader, resolver, path,
 * repository, database, clock, telemetry, or mutation handle.
 */
export interface GraphFacts {
  readonly broken: readonly ContextualBrokenFinding[];
  readonly unlinked: readonly ContextualUnlinkedFinding[];
  readonly oneWay: readonly ContextualOneWayFinding[];
}

export interface GraphRule extends RuleMetadata {
  /** Consumes the whole immutable snapshot and returns findings in rule-declared order. */
  readonly evaluate: (facts: GraphFacts) => readonly FindingDraft[];
}

const linksBroken: GraphRule = {
  id: 'links.broken',
  version: 1,
  profile: 'links',
  impact: 'warning',
  basis: 'invariant',
  requiredFacts: ['broken'],
  evaluate: facts =>
    facts.broken.map(occurrence => ({
      primary: { id: occurrence.sourceId, role: 'primary' as const },
      message: 'Authored wikilink target does not resolve',
      evidence: [
        { label: 'sourceTitle', value: occurrence.sourceTitle },
        { label: 'target', value: occurrence.brokenTarget },
        { label: 'line', value: occurrence.line },
      ],
      // Source note, normalized target, and occurrence start offset keep
      // repeated authored occurrences of the same broken target distinct.
      identity: [occurrence.sourceId, occurrence.brokenTarget, occurrence.offset],
    })),
};

const linksUnlinked: GraphRule = {
  id: 'links.unlinked',
  version: 1,
  profile: 'links',
  impact: 'info',
  basis: 'heuristic',
  requiredFacts: ['unlinked'],
  evaluate: facts =>
    facts.unlinked.map(note => ({
      primary: { id: note.id, role: 'primary' as const },
      message: 'Note has no authored incoming or outgoing wikilink',
      evidence: [
        { label: 'title', value: note.title },
        { label: 'kind', value: note.kind },
        { label: 'status', value: note.status },
      ],
      identity: [note.id],
    })),
};

const linksReciprocalMissing: GraphRule = {
  id: 'links.reciprocal-missing',
  version: 1,
  profile: 'links',
  impact: 'info',
  basis: 'heuristic',
  requiredFacts: ['oneWay'],
  evaluate: facts =>
    facts.oneWay.map(edge => ({
      primary: { id: edge.sourceId, role: 'primary' as const },
      related: [{ id: edge.targetId, role: 'related' as const }],
      message: 'Resolved edge has no authored reverse edge',
      evidence: [
        { label: 'sourceTitle', value: edge.sourceTitle },
        { label: 'targetTitle', value: edge.targetTitle },
      ],
      identity: [edge.sourceId, edge.targetId],
    })),
};

/** Closed built-in graph inventory, in rule-id declaration order. */
export const BUILTIN_GRAPH_RULES: readonly GraphRule[] = [linksBroken, linksUnlinked, linksReciprocalMissing];

/** Metadata-only view for the combined internal built-in inventory. */
export const GRAPH_RULE_METADATA: readonly RuleMetadata[] = BUILTIN_GRAPH_RULES.map(
  ({ id, version, profile, impact, basis, requiredFacts }) => ({ id, version, profile, impact, basis, requiredFacts }),
);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export interface GraphEvaluationOptions {
  readonly ruleIds?: readonly string[];
  readonly scope?: ReviewScope;
}

/**
 * Evaluates one immutable graph snapshot through the selected closed graph
 * rules, reusing `finalizeFinding()` for rule id/version/impact/basis and the
 * canonical fingerprint. The result — findings, evidence, subjects, groups,
 * and totals — is deep-frozen so source-array mutation cannot alter it.
 */
export function evaluateGraphReview(facts: GraphFacts, options: GraphEvaluationOptions = {}): EvaluationResult {
  // Do not freeze caller-owned objects: callers may retain their scan result.
  // Rules instead get a copied, deeply frozen plain-data snapshot, preventing
  // either rule mutation or later caller mutation from affecting evaluation.
  const snapshot = deepFreeze<GraphFacts>({
    broken: facts.broken.map(occurrence => ({ ...occurrence })),
    unlinked: facts.unlinked.map(note => ({ ...note, tags: [...note.tags] })),
    oneWay: facts.oneWay.map(edge => ({ ...edge })),
  });
  const selected = BUILTIN_GRAPH_RULES.filter(rule => !options.ruleIds || options.ruleIds.includes(rule.id));
  const groups: FindingGroup[] = selected.map(rule => {
    const findings: Finding[] = rule.evaluate(snapshot).map(draft => finalizeFinding(rule, draft));
    return { ruleId: rule.id, findings, total: findings.length };
  });
  const scope: ReviewScope = options.scope?.kind === 'project'
    ? { kind: 'project', project: options.scope.project, ...(options.scope.client ? { client: options.scope.client } : {}) }
    : { kind: 'full' };
  return deepFreeze({
    profile: 'links',
    scope,
    groups,
    totals: Object.fromEntries(groups.map(group => [group.ruleId, group.total])),
  });
}
