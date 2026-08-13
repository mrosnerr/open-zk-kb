// review/graph.ts
//
// Rule-driven contextual graph review orchestrator. Selects built-in rules,
// materializes only their transitive fact dependencies exactly once per
// invocation, and evaluates formal findings from frozen, declared-keys-only
// slices. See src/review/README.md for the fact/plan/rule boundary.

import type { ContextualLinkFailure, ContextualLinkReadResult, ContextualLinkResolution, ContextualScanTotals } from '../link-health/types.js';
import { deepFreeze } from '../utils/deep-freeze.js';
import { type GraphPlan, planGraphFacts, sliceGraphFacts } from './graph-plan.js';
import {
  buildContextualLinkFacts,
  buildDocumentApplicabilityFacts,
  buildGraphEdgeFacts,
  buildResolvedLinkFacts,
} from './graph-providers.js';
import { BUILTIN_GRAPH_RULES, GRAPH_RULE_METADATA } from './graph-rules.js';
import { requireFact, type GraphFactKey, type GraphFacts } from './graph-types.js';
import { finalizeFinding } from './registry.js';
import type { EvaluationResult, Finding, FindingGroup, ReviewScope } from './types.js';

export { BUILTIN_GRAPH_RULES, GRAPH_RULE_METADATA, planGraphFacts };
export type { GraphPlan } from './graph-plan.js';
export type {
  ContextualLinkFacts,
  ContextualOccurrence,
  DocumentApplicability,
  DocumentApplicabilityFacts,
  GraphDocument,
  GraphEdge,
  GraphEdgeFacts,
  GraphFactKey,
  GraphFacts,
  GraphRule,
  GraphRuleId,
  ResolvedLinkFacts,
  ResolvedLinkTarget,
  ResolvedOccurrence,
} from './graph-types.js';

export interface GraphReviewResult {
  readonly plan: GraphPlan;
  readonly facts: GraphFacts;
  readonly review: EvaluationResult;
  readonly totals: ContextualScanTotals;
  readonly failures: readonly ContextualLinkFailure[];
  /** True when any document failed to read or parse; `links.unlinked` suppresses all findings in that case. */
  readonly incompleteGraph: boolean;
  /** Test-only visibility into which fact layers actually ran, in execution order. */
  readonly executionTrace: readonly GraphFactKey[];
}

/** Defensively copies caller-owned read results so a later caller-side mutation can never alter this evaluation. */
function copyReadResult(entry: ContextualLinkReadResult): ContextualLinkReadResult {
  const document = { ...entry.document, tags: [...entry.document.tags] };
  return entry.ok ? { document, ok: true, source: entry.source } : { document, ok: false, reason: entry.reason };
}

/** Materializes one fact layer from already-completed prior layers, in the plan's dependency order. */
function applyGraphFactLayer(
  key: GraphFactKey,
  facts: GraphFacts,
  documents: readonly ContextualLinkReadResult[],
  resolve: (slug: string) => ContextualLinkResolution,
): GraphFacts {
  switch (key) {
    case 'contextual-links':
      return { ...facts, contextualLinks: deepFreeze(buildContextualLinkFacts(documents)) };
    case 'resolved-links':
      return { ...facts, resolvedLinks: deepFreeze(buildResolvedLinkFacts(requireFact(facts, 'contextualLinks'), resolve)) };
    case 'graph-edges':
      return {
        ...facts,
        graphEdges: deepFreeze(buildGraphEdgeFacts(requireFact(facts, 'contextualLinks'), requireFact(facts, 'resolvedLinks'))),
      };
    case 'document-applicability':
      return { ...facts, documentApplicability: deepFreeze(buildDocumentApplicabilityFacts(requireFact(facts, 'contextualLinks'))) };
  }
}

/**
 * Plans the selected built-in graph rules, materializes each planned fact
 * layer exactly once, and evaluates formal findings from a frozen,
 * declared-keys-only slice per rule. `documents` and `scope` are copied
 * before use, so no caller-owned value is mutated or frozen.
 */
export function materializeGraphReview(
  documents: readonly ContextualLinkReadResult[],
  resolve: (slug: string) => ContextualLinkResolution,
  ruleIds: readonly string[] = BUILTIN_GRAPH_RULES.map(rule => rule.id),
  scope?: ReviewScope,
): GraphReviewResult {
  const plan = planGraphFacts(ruleIds);
  const copiedDocuments = documents.map(copyReadResult);

  const executionTrace: GraphFactKey[] = [];
  let facts: GraphFacts = {};
  for (const key of plan.providerKeys) {
    executionTrace.push(key);
    facts = applyGraphFactLayer(key, facts, copiedDocuments, resolve);
  }
  facts = deepFreeze(facts);

  const groups: FindingGroup[] = plan.ruleIds.map(ruleId => {
    const rule = BUILTIN_GRAPH_RULES.find(candidate => candidate.id === ruleId);
    if (!rule) throw new Error(`Missing planned graph rule: ${ruleId}`);
    const slice = deepFreeze(sliceGraphFacts(facts, rule.requiredFacts));
    const findings: Finding[] = rule.evaluate(slice).map(draft => finalizeFinding(rule, draft));
    return { ruleId, findings, total: findings.length };
  });

  const review: EvaluationResult = deepFreeze({
    profile: 'links',
    scope: scope ? { ...scope } : { kind: 'full' as const },
    groups,
    totals: Object.fromEntries(groups.map(group => [group.ruleId, group.total])),
  });

  const contextualLinks = requireFact(facts, 'contextualLinks');
  return deepFreeze({
    plan,
    facts,
    review,
    totals: contextualLinks.totals,
    failures: contextualLinks.failures,
    incompleteGraph: contextualLinks.failures.length > 0,
    executionTrace,
  });
}
