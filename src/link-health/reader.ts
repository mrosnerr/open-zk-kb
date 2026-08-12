// link-health/reader.ts
//
// Query-only production reader consumed by rule-driven graph fact
// materialization. Providers receive only plain `ContextualLinkReadResult`
// values and a `resolveTarget` query function — never a filesystem,
// repository, or database handle. Only this adapter reads files or queries
// `NoteRepository`.

import * as fs from 'node:fs';
import type { NoteRepository } from '../storage/NoteRepository.js';
import type { NoteKind, NoteStatus } from '../types.js';
import type { ContextualLinkDocument, ContextualLinkReadResult, ContextualLinkResolution } from './types.js';

/**
 * Placeholder metadata for a canonical Markdown file the index does not
 * account for. Such an entry is always an unreadable document, so only its
 * synthetic identity is ever surfaced — no path, title, or content.
 */
const UNINDEXED_TITLE = 'Unindexed canonical Markdown file';
const UNINDEXED_KIND: NoteKind = 'observation';
const UNINDEXED_STATUS: NoteStatus = 'fleeting';

export interface ContextualLinkReader {
  /** Active, non-structural documents with their raw-source read outcome, in a stable order. */
  readonly listDocuments: () => readonly ContextualLinkReadResult[];
  /** Resolves a wikilink slug to its complete neutral resolution outcome using existing repository semantics. */
  readonly resolveTarget: (slug: string) => ContextualLinkResolution;
}

export function createRepositoryContextualLinkReader(repository: NoteRepository): ContextualLinkReader {
  return {
    // Canonical Markdown outside the index is appended as a read failure so an
    // incomplete document set can never be reviewed as if it were complete.
    listDocuments: () =>
      Object.freeze([
        ...repository.getContextualLinkDocuments().map(row => {
          const document: ContextualLinkDocument = Object.freeze({
            id: row.id,
            title: row.title,
            kind: row.kind,
            status: row.status,
            tags: Object.freeze([...row.tags]),
          });
          try {
            const source = fs.readFileSync(row.path, 'utf-8');
            return Object.freeze({ document, ok: true as const, source });
          } catch {
            return Object.freeze({ document, ok: false as const, reason: 'read-failed' });
          }
        }),
        ...repository.getUnindexedCanonicalDocuments().map(entry =>
          Object.freeze({
            document: Object.freeze({
              id: entry.id,
              title: UNINDEXED_TITLE,
              kind: UNINDEXED_KIND,
              status: UNINDEXED_STATUS,
              tags: Object.freeze([]) as readonly string[],
            }),
            ok: false as const,
            reason: entry.reason,
          })
        ),
      ]),
    resolveTarget: slug => repository.resolveContextualLink(slug),
  };
}
