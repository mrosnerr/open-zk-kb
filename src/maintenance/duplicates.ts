import type { NoteMetadata } from '../storage/NoteRepository.js';
import { computeSimHash, hammingDistance } from '../utils/simhash.js';

export const DUPLICATE_SIMHASH_THRESHOLD = 3;

export interface DuplicateSnapshotNote {
  readonly note: NoteMetadata;
  readonly hash: string;
  readonly hashSource: 'stored' | 'ephemeral';
}

export interface SimHashGroup {
  readonly seedId: string;
  readonly notes: readonly NoteMetadata[];
  readonly evidence: readonly { noteId: string; distanceFromSeed: number }[];
}

export interface DuplicateEvaluation {
  readonly coverage: {
    readonly eligible: number;
    readonly hashedAtStart: number;
    readonly computedEphemerally: number;
    readonly evaluated: number;
    readonly omitted: number;
    readonly omissionReasons: Readonly<Record<string, number>>;
    readonly complete: boolean;
  };
  readonly titleGroups: readonly { normalizedTitle: string; notes: readonly NoteMetadata[] }[];
  readonly simhashGroups: readonly SimHashGroup[];
  readonly threshold: number;
}

/**
 * Canonical comparison key for duplicate-title grouping, shared with the
 * repository's title-collision detection. Applies kind-prefix and `.md`
 * stripping and lowercasing to the full title, and collapses runs of
 * non-alphanumeric characters to a single space instead of
 * deleting them, so distinct word sequences (`note book` vs `notebook`) stay
 * distinct keys. Returns `''` for a title with no alphanumeric content;
 * callers skip empty keys rather than grouping unrelated notes together.
 */
export function normalizeComparableTitle(title: string): string {
  return title.toLowerCase()
    .replace(/^(reference|action|decision|research):\s*/i, '')
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function evaluateDuplicates(
  input: readonly (NoteMetadata & { content_hash?: string | null })[],
  threshold = DUPLICATE_SIMHASH_THRESHOLD,
): DuplicateEvaluation {
  const ordered = [...input].sort((a, b) => a.id.localeCompare(b.id));
  const snapshot: DuplicateSnapshotNote[] = ordered.map(note => {
    const stored = typeof note.content_hash === 'string' && /^[0-9a-f]{16}$/i.test(note.content_hash)
      ? note.content_hash.toLowerCase()
      : undefined;
    return {
      note,
      hash: stored ?? computeSimHash(note.summary || note.content || note.title),
      hashSource: stored ? 'stored' : 'ephemeral',
    };
  });

  const byTitle = new Map<string, NoteMetadata[]>();
  for (const item of snapshot) {
    const key = normalizeComparableTitle(item.note.title);
    if (!key) continue;
    const notes = byTitle.get(key) ?? [];
    notes.push(item.note);
    byTitle.set(key, notes);
  }
  const titleGroups = [...byTitle.entries()]
    .filter(([, notes]) => notes.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([normalizedTitle, notes]) => ({ normalizedTitle, notes }));

  const assigned = new Set<string>();
  const simhashGroups: SimHashGroup[] = [];
  for (let i = 0; i < snapshot.length; i++) {
    const seed = snapshot[i];
    if (assigned.has(seed.note.id)) continue;
    const members = [seed];
    assigned.add(seed.note.id);
    for (let j = i + 1; j < snapshot.length; j++) {
      const candidate = snapshot[j];
      if (!assigned.has(candidate.note.id) && hammingDistance(seed.hash, candidate.hash) <= threshold) {
        members.push(candidate);
        assigned.add(candidate.note.id);
      }
    }
    if (members.length > 1) {
      simhashGroups.push({
        seedId: seed.note.id,
        notes: members.map(item => item.note),
        evidence: members.slice(1).map(item => ({ noteId: item.note.id, distanceFromSeed: hammingDistance(seed.hash, item.hash) })),
      });
    }
  }

  const hashedAtStart = snapshot.filter(item => item.hashSource === 'stored').length;
  return {
    coverage: {
      eligible: snapshot.length,
      hashedAtStart,
      computedEphemerally: snapshot.length - hashedAtStart,
      evaluated: snapshot.length,
      omitted: 0,
      omissionReasons: {},
      complete: true,
    },
    titleGroups,
    simhashGroups,
    threshold,
  };
}
