// review/graph-plan.ts
//
// Closed dependency planning for the rule-driven contextual graph pipeline.
// Rule ids and fact keys are compiled TypeScript values, never strings
// loaded from configuration; the planner rejects an unknown requested rule
// id, an unknown fact key, and a dependency cycle deterministically before
// any document is read or rule evaluated.

import { deepFreeze } from '../utils/deep-freeze.js';
import type { GraphFactKey, GraphFacts, GraphRuleId } from './graph-types.js';
import { BUILTIN_GRAPH_RULES } from './graph-rules.js';

/** Direct dependencies for each built-in fact layer, in canonical declaration order. */
const GRAPH_FACT_DEPENDENCIES: Readonly<Record<GraphFactKey, readonly GraphFactKey[]>> = {
  'contextual-links': [],
  'resolved-links': ['contextual-links'],
  'graph-edges': ['resolved-links'],
  'document-applicability': ['contextual-links'],
};

export interface GraphPlan {
  readonly ruleIds: readonly GraphRuleId[];
  readonly providerKeys: readonly GraphFactKey[];
}

/**
 * Computes the deterministic transitive closure of `keys` under
 * `dependencies`. Top-level keys are visited in the given order (built-in
 * rule declaration order in practice); each key's own dependencies are
 * visited in stable alphabetical order as a tie-break. Repeated calls with
 * identical input always emit the same provider order. Exported standalone
 * so unknown-key and cycle rejection can be tested without the built-in
 * graph-rule registry.
 */
export function orderFactKeys(
  keys: readonly GraphFactKey[],
  dependencies: Readonly<Record<GraphFactKey, readonly GraphFactKey[]>>,
): readonly GraphFactKey[] {
  const done = new Set<GraphFactKey>();
  const visiting = new Set<GraphFactKey>();
  const order: GraphFactKey[] = [];

  const declares = (key: GraphFactKey): boolean => Object.hasOwn(dependencies, key);

  const visit = (key: GraphFactKey): void => {
    // Own-property check only: an inherited `Object.prototype` name (e.g.
    // `toString`) is not a declared fact key and must be rejected.
    if (!declares(key)) throw new Error(`Unknown graph fact key: ${key}`);
    if (done.has(key)) return;
    if (visiting.has(key)) throw new Error(`Graph fact dependency cycle at: ${key}`);
    visiting.add(key);
    for (const dependency of [...dependencies[key]].sort()) visit(dependency);
    visiting.delete(key);
    done.add(key);
    order.push(key);
  };

  for (const key of keys) visit(key);
  return order;
}

/**
 * Selects built-in rules by id in registry declaration order, rejects an
 * unknown requested id before any document read, and unions/orders their
 * transitive fact dependencies. The result is a plain, frozen description;
 * there is no process-global or persisted plan cache.
 */
export function planGraphFacts(ruleIds: readonly string[]): GraphPlan {
  if (ruleIds.length === 0) throw new Error('No graph rules requested');
  for (const id of ruleIds) {
    // Explicit per-id check: an empty or otherwise falsy id must be rejected
    // as unknown rather than skipped by a truthiness test.
    if (!BUILTIN_GRAPH_RULES.some(rule => rule.id === id)) throw new Error(`Unknown graph rule: ${id}`);
  }

  const selected = BUILTIN_GRAPH_RULES.filter(rule => ruleIds.includes(rule.id));
  const requiredKeys = selected.flatMap(rule => rule.requiredFacts);

  return deepFreeze({
    ruleIds: selected.map(rule => rule.id),
    providerKeys: orderFactKeys(requiredKeys, GRAPH_FACT_DEPENDENCIES),
  });
}

/** Builds the frozen, declared-keys-only fact slice one rule receives — never the full materialized bag. */
export function sliceGraphFacts(facts: GraphFacts, keys: readonly GraphFactKey[]): GraphFacts {
  let slice: GraphFacts = {};
  for (const key of keys) {
    switch (key) {
      case 'contextual-links':
        slice = { ...slice, contextualLinks: facts.contextualLinks };
        break;
      case 'resolved-links':
        slice = { ...slice, resolvedLinks: facts.resolvedLinks };
        break;
      case 'graph-edges':
        slice = { ...slice, graphEdges: facts.graphEdges };
        break;
      case 'document-applicability':
        slice = { ...slice, documentApplicability: facts.documentApplicability };
        break;
    }
  }
  return slice;
}
