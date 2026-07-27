// link-health/reader.ts
//
// Query-only production reader consumed by rule-driven graph fact
// materialization. Providers receive only plain `ContextualLinkReadResult`
// values and a `resolveTarget` query function — never a filesystem,
// repository, or database handle. Only this adapter reads files or queries
// `NoteRepository`.

import * as fs from 'node:fs';
import type { NoteRepository } from '../storage/NoteRepository.js';
import type { ContextualLinkDocument, ContextualLinkReadResult, ContextualLinkResolution } from './types.js';

export interface ContextualLinkReader {
  /** Active, non-structural documents with their raw-source read outcome, in a stable order. */
  readonly listDocuments: () => readonly ContextualLinkReadResult[];
  /** Resolves a wikilink slug to its complete neutral resolution outcome using existing repository semantics. */
  readonly resolveTarget: (slug: string) => ContextualLinkResolution;
}

export function createRepositoryContextualLinkReader(repository: NoteRepository): ContextualLinkReader {
  return {
    listDocuments: () =>
      Object.freeze(
        repository.getContextualLinkDocuments().map(row => {
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
        })
      ),
    resolveTarget: slug => repository.resolveContextualLink(slug),
  };
}
