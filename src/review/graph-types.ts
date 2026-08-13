// review/graph-types.ts
//
// Neutral, immutable fact shapes for the rule-driven contextual graph
// review pipeline (see src/review/README.md). Providers in
// `graph-providers.ts` compute these plain, JSON-compatible values; rules
// in `graph-rules.ts` interpret them. No provider or fact shape here
// carries impact, basis, message, or repair policy — see `GraphRule`.

import type { KnowledgeApplicability } from '../knowledge-scope.js';
import type { ContextualLinkFailure, ContextualScanTotals } from '../link-health/types.js';
import type { NoteKind, NoteStatus } from '../types.js';
import type { FindingDraft, RuleMetadata } from './types.js';

/** Closed set of built-in graph fact-provider layers. Not a public/plugin key space. */
export type GraphFactKey = 'contextual-links' | 'resolved-links' | 'graph-edges' | 'document-applicability';

/** Closed set of built-in graph rule ids, in registry declaration order. */
export type GraphRuleId = 'links.broken' | 'links.unlinked' | 'links.reciprocal-missing';

/** Identity/metadata for one active, non-structural document in this scan, whether it read/parsed or not. */
export interface GraphDocument {
  readonly id: string;
  readonly title: string;
  readonly kind: NoteKind;
  readonly status: NoteStatus;
  readonly tags: readonly string[];
}

/** One authored contextual wikilink occurrence, before target resolution. */
export interface ContextualOccurrence {
  readonly sourceId: string;
  readonly sourceTitle: string;
  /** Normalized wikilink slug, exactly as authored. */
  readonly target: string;
  /** One-based line, derived from the contextual UTF-16 source range. */
  readonly line: number;
  /** Zero-based UTF-16 start offset; keeps repeated occurrences of the same target distinct. */
  readonly offset: number;
}

/**
 * The complete, neutral outcome of resolving one authored occurrence's
 * target — a discriminated outcome rather than a string sentinel. `document`
 * means the slug resolves to some note id, which may or may not participate
 * in the active graph (see `buildGraphEdgeFacts`). `vault-target` means an
 * existing unindexed vault Markdown file or directory-index Markdown file: a
 * valid target outside the active graph, carrying no path or other
 * identity. `unresolved` means no target exists.
 */
export type ResolvedLinkTarget =
  | { readonly kind: 'document'; readonly id: string }
  | { readonly kind: 'vault-target' }
  | { readonly kind: 'unresolved' };

export interface ResolvedOccurrence extends ContextualOccurrence {
  readonly resolution: ResolvedLinkTarget;
}

/** A deduplicated resolved source→target edge between two active, non-structural documents. */
export interface GraphEdge {
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly targetId: string;
  readonly targetTitle: string;
}

/** Canonical applicability classification for one document, used only by publication-edge policy. */
export interface DocumentApplicability {
  readonly id: string;
  readonly type: KnowledgeApplicability['type'];
}

export interface ContextualLinkFacts {
  readonly documents: readonly GraphDocument[];
  readonly occurrences: readonly ContextualOccurrence[];
  readonly failures: readonly ContextualLinkFailure[];
  readonly totals: ContextualScanTotals;
}

export interface ResolvedLinkFacts {
  readonly occurrences: readonly ResolvedOccurrence[];
}

export interface GraphEdgeFacts {
  readonly edges: readonly GraphEdge[];
  /** Document ids that failed to read or parse this invocation; rules own suppression. */
  readonly failedDocumentIds: readonly string[];
  /** Document ids with at least one authored occurrence, resolved or not. */
  readonly outgoingCandidateIds: readonly string[];
}

export interface DocumentApplicabilityFacts {
  readonly values: readonly DocumentApplicability[];
}

/** Invocation-local materialized fact bag. A field is present only when its layer was planned. */
export interface GraphFacts {
  readonly contextualLinks?: ContextualLinkFacts;
  readonly resolvedLinks?: ResolvedLinkFacts;
  readonly graphEdges?: GraphEdgeFacts;
  readonly documentApplicability?: DocumentApplicabilityFacts;
}

/** Narrows a fact field the caller has declared present; throws if the planner did not materialize it first. */
export function requireFact<K extends keyof GraphFacts>(facts: GraphFacts, key: K): NonNullable<GraphFacts[K]> {
  const value = facts[key];
  if (value === undefined) {
    throw new Error(`Graph fact "${key}" was not materialized before rule evaluation`);
  }
  return value;
}

export interface GraphRule extends RuleMetadata {
  readonly id: GraphRuleId;
  readonly requiredFacts: readonly GraphFactKey[];
  /** Receives only a deeply frozen slice containing its own declared fact keys — see `sliceGraphFacts`. */
  readonly evaluate: (facts: GraphFacts) => readonly FindingDraft[];
}
