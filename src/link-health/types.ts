// link-health/types.ts
//
// Immutable types for the contextual link-health evaluator. A
// `ContextualLinkDocument` is the minimal identity/metadata slice the pure
// evaluator needs for an active, non-structural note: no path, content
// beyond raw source bytes, or repository/database handle ever crosses this
// boundary (see `reader.ts`).

import type { NoteKind, NoteStatus } from '../types.js';

/** Identity and metadata for one active, non-structural note. */
export interface ContextualLinkDocument {
  readonly id: string;
  readonly title: string;
  readonly kind: NoteKind;
  readonly status: NoteStatus;
  readonly tags: readonly string[];
}

/** One document's raw-source read/parse outcome, as returned by a reader. */
export type ContextualLinkReadResult =
  | Readonly<{ document: ContextualLinkDocument; ok: true; source: string }>
  | Readonly<{ document: ContextualLinkDocument; ok: false; reason: string }>;

/** A read or parse failure surfaced by note identity only — no path or content. */
export interface ContextualLinkFailure {
  readonly id: string;
  readonly title: string;
}

/** One authored contextual wikilink occurrence that failed to resolve. */
export interface ContextualBrokenFinding {
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly brokenTarget: string;
  /** One-based line, derived from the contextual UTF-16 source range. */
  readonly line: number;
}

/** An active non-structural note with neither an outgoing candidate nor a resolved incoming edge. */
export interface ContextualUnlinkedFinding {
  readonly id: string;
  readonly title: string;
  readonly kind: NoteKind;
  readonly status: NoteStatus;
  readonly tags: readonly string[];
}

/** A resolved, deduplicated source→target edge lacking its reverse edge. */
export interface ContextualOneWayFinding {
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly targetId: string;
  readonly targetTitle: string;
}

/** Deterministic scan totals shared by every migrated action, independent of elapsed timing. */
export interface ContextualScanTotals {
  readonly documentsParsed: number;
  readonly rawCandidates: number;
  readonly contextualLinks: number;
  readonly excludedCandidates: number;
  readonly parseFailures: number;
}

export interface ContextualLinkGraphResult {
  readonly totals: ContextualScanTotals;
  readonly failures: readonly ContextualLinkFailure[];
  readonly broken: readonly ContextualBrokenFinding[];
  /** Empty and meaningless whenever `incompleteGraph` is true. */
  readonly unlinked: readonly ContextualUnlinkedFinding[];
  readonly oneWay: readonly ContextualOneWayFinding[];
  /** True when any document failed to read or parse; unlinked findings are suppressed. */
  readonly incompleteGraph: boolean;
}
