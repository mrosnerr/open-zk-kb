import type { VisibilityOptions } from '../knowledge-scope.js';
import type { NoteMetadata, NoteRepository } from '../storage/NoteRepository.js';
import type { ReviewScope } from './types.js';

/**
 * Query-only interface consumed by the fact builder. The production adapter
 * delegates every visibility decision to `NoteRepository`'s canonical
 * `visibilityPredicate` — this module never re-implements project/client
 * scoping itself, so it cannot drift from (or leak around) that predicate.
 * No store, update, telemetry, embedding-write, navigation, or filesystem
 * method is exposed.
 */
export interface ReviewReader {
  readonly listNotes: (scope: ReviewScope) => readonly NoteMetadata[];
  /** Batch backlink counts keyed by target note id — never a per-note lookup. */
  readonly backlinkCounts: (scope: ReviewScope) => ReadonlyMap<string, number>;
}

function toVisibility(scope: ReviewScope): VisibilityOptions | undefined {
  return scope.kind === 'project' ? { project: scope.project, client: scope.client } : undefined;
}

export function createRepositoryReviewReader(repository: NoteRepository): ReviewReader {
  return {
    listNotes: scope => repository.getReviewNotes(toVisibility(scope)),
    backlinkCounts: scope => repository.getReviewBacklinkCounts(toVisibility(scope)),
  };
}
