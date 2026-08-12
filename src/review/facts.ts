import { atomicityWarnThreshold, KIND_WORD_GUIDELINES } from '../content-guidelines.js';
import { parseKnowledgeApplicability } from '../knowledge-scope.js';
import type { NoteMetadata } from '../storage/NoteRepository.js';
import type { ReviewReader } from './reader.js';
import type { NoteFacts, ReviewScope } from './types.js';

const DAY = 86_400_000;

/** Matches `content-splitter.ts#countWords` exactly (no trim, no unicode flag). */
function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Materializes immutable shared note facts once per evaluation, using a
 * single injected clock (`now`) and one batch backlink query (via
 * `reader.backlinkCounts`) rather than a per-note lookup. Retains a source
 * ordinal so compatibility rules can preserve repository order.
 */
export function buildReviewSnapshot(reader: ReviewReader, scope: ReviewScope, now: number): readonly NoteFacts[] {
  const notes = reader.listNotes(scope);
  const backlinks = reader.backlinkCounts(scope);

  return Object.freeze(notes.map((note: NoteMetadata, ordinal) => {
    const anchor = note.last_accessed_at ?? note.created_at;
    const guide = KIND_WORD_GUIDELINES[note.kind];
    const trimmedTitle = note.title.trim();

    return Object.freeze({
      ordinal,
      note: Object.freeze({
        id: note.id,
        title: note.title,
        kind: note.kind,
        status: note.status,
        lifecycle: note.lifecycle,
        tags: Object.freeze([...note.tags]),
        content: note.content,
        summary: note.summary,
        guidance: note.guidance,
        created_at: note.created_at,
        updated_at: note.updated_at,
        access_count: note.access_count ?? 0,
        last_accessed_at: note.last_accessed_at,
        word_count: note.word_count,
      }),
      applicability: Object.freeze(parseKnowledgeApplicability(note.tags)),
      ageDays: Math.floor((now - note.created_at) / DAY),
      staleDays: Math.max(0, Math.floor((now - anchor) / DAY)),
      backlinks: backlinks.get(note.id) ?? 0,
      contentWords: countWords(note.content),
      titleWords: trimmedTitle ? trimmedTitle.split(/\s+/).filter(Boolean).length : 0,
      titleWordsRaw: note.title.split(/\s+/).length,
      wordGuidance: Object.freeze({
        target: guide ? guide.target : ('?' as const),
        warn: guide ? guide.warn : atomicityWarnThreshold(note.kind),
      }),
    });
  }));
}
