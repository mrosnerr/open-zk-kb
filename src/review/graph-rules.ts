// review/graph-rules.ts
//
// Closed built-in graph rules. Rules — not providers or adapters — own
// every semantic judgment: unresolved-target classification, isolation,
// incomplete-scan suppression, missing reciprocity, and the
// project-local-to-global publication exemption. See `graph-providers.ts`
// for the strictly computational fact layers rules consume.

import { requireFact, type GraphFacts, type GraphRule } from './graph-types.js';
import type { RuleMetadata } from './types.js';

const broken: GraphRule = {
  id: 'links.broken',
  version: 1,
  profile: 'links',
  impact: 'warning',
  basis: 'invariant',
  requiredFacts: ['resolved-links'],
  evaluate: (facts: GraphFacts) => {
    const { occurrences } = requireFact(facts, 'resolvedLinks');
    return occurrences
      .filter(occurrence => occurrence.resolution.kind === 'unresolved')
      .map(occurrence => ({
        primary: { id: occurrence.sourceId, role: 'primary' as const },
        message: 'Authored wikilink target does not resolve',
        evidence: [
          { label: 'sourceTitle', value: occurrence.sourceTitle },
          { label: 'target', value: occurrence.target },
          { label: 'line', value: occurrence.line },
        ],
        identity: [occurrence.sourceId, occurrence.target, occurrence.offset],
      }));
  },
};

const unlinked: GraphRule = {
  id: 'links.unlinked',
  version: 1,
  profile: 'links',
  impact: 'info',
  basis: 'heuristic',
  requiredFacts: ['contextual-links', 'graph-edges'],
  evaluate: (facts: GraphFacts) => {
    const contextualLinks = requireFact(facts, 'contextualLinks');
    // Any read/parse failure leaves an unknown document that could hold an
    // unknown incoming edge to any note, so isolation is unknowable.
    if (contextualLinks.failures.length > 0) return [];

    const graphEdges = requireFact(facts, 'graphEdges');
    const incoming = new Set(graphEdges.edges.map(edge => edge.targetId));
    const outgoing = new Set(graphEdges.outgoingCandidateIds);

    return contextualLinks.documents
      .filter(document => !incoming.has(document.id) && !outgoing.has(document.id))
      .map(document => ({
        primary: { id: document.id, role: 'primary' as const },
        message: 'Note has no authored incoming or outgoing wikilink',
        evidence: [
          { label: 'title', value: document.title },
          { label: 'kind', value: document.kind },
          { label: 'status', value: document.status },
        ],
        identity: [document.id],
      }));
  },
};

const reciprocal: GraphRule = {
  id: 'links.reciprocal-missing',
  version: 1,
  profile: 'links',
  impact: 'info',
  basis: 'heuristic',
  requiredFacts: ['graph-edges', 'document-applicability'],
  evaluate: (facts: GraphFacts) => {
    const graphEdges = requireFact(facts, 'graphEdges');
    const applicability = requireFact(facts, 'documentApplicability');
    const failedTargets = new Set(graphEdges.failedDocumentIds);
    const reversePairs = new Set(graphEdges.edges.map(edge => `${edge.sourceId}\0${edge.targetId}`));
    const applicabilityById = new Map(applicability.values.map(value => [value.id, value.type]));

    return graphEdges.edges
      .filter(edge => {
        // The target document failed to read/parse: its reverse edge is unknown.
        if (failedTargets.has(edge.targetId)) return false;
        if (reversePairs.has(`${edge.targetId}\0${edge.sourceId}`)) return false;
        // A project-local source publishing to a global target is an
        // intentional one-way publication edge, not a missing reciprocal link.
        const sourceType = applicabilityById.get(edge.sourceId);
        const targetType = applicabilityById.get(edge.targetId);
        return !(sourceType === 'project-local' && targetType === 'global');
      })
      // Deduplicated edges already arrive in authored occurrence order from
      // `buildGraphEdgeFacts`; re-sorting by title would discard that
      // deterministic provider order for a display-only one.
      .map(edge => ({
        primary: { id: edge.sourceId, role: 'primary' as const },
        related: [{ id: edge.targetId, role: 'related' as const }],
        message: 'Resolved edge has no authored reverse edge',
        evidence: [
          { label: 'sourceTitle', value: edge.sourceTitle },
          { label: 'targetTitle', value: edge.targetTitle },
        ],
        identity: [edge.sourceId, edge.targetId],
      }));
  },
};

export const BUILTIN_GRAPH_RULES: readonly GraphRule[] = [broken, unlinked, reciprocal];

export const GRAPH_RULE_METADATA: readonly RuleMetadata[] = BUILTIN_GRAPH_RULES.map(({ evaluate: _evaluate, ...metadata }) => metadata);
