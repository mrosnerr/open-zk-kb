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

/**
 * The complete, neutral outcome of resolving one authored wikilink target —
 * a discriminated outcome rather than a string sentinel. `document` means
 * the slug resolves to some note id, which may or may not participate in
 * the active graph. `vault-target` means an existing unindexed vault
 * Markdown file or directory-index Markdown file: a valid target outside
 * the active graph, carrying no path or other identity. `unresolved` means
 * no target exists.
 */
export type ContextualLinkResolution =
  | { readonly kind: 'document'; readonly id: string }
  | { readonly kind: 'vault-target' }
  | { readonly kind: 'unresolved' };

/** Deterministic scan totals shared by every migrated action, independent of elapsed timing. */
export interface ContextualScanTotals {
  readonly documentsParsed: number;
  readonly rawCandidates: number;
  readonly contextualLinks: number;
  readonly excludedCandidates: number;
  readonly parseFailures: number;
}
