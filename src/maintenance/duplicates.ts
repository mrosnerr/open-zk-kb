import type { NoteMetadata } from '../storage/NoteRepository.js';
import { computeSimHash, hammingDistance } from '../utils/simhash.js';

export const DUPLICATE_SIMHASH_THRESHOLD = 3;
export const DUPLICATE_EVIDENCE_LIMIT = 10;

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

export interface DuplicateIncompletenessEvidence {
  readonly omissionReasons: Readonly<Record<string, number>>;
  /** Indexed rows may no longer represent their canonical Markdown. */
  readonly indexedSnapshotUnsafe?: boolean;
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
  /** Complete count of qualifying pairs; simhashGroups retains bounded advisory evidence. */
  readonly simhashGroupTotal: number;
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
  return title.normalize('NFC').toLowerCase()
    .replace(/^(reference|action|decision|research):\s*/i, '')
    .replace(/\.md$/i, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

export function evaluateDuplicates(
  input: readonly (NoteMetadata & { content_hash?: string | null })[],
  threshold = DUPLICATE_SIMHASH_THRESHOLD,
  incompleteness?: DuplicateIncompletenessEvidence,
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

  // Report each qualifying pair independently. A greedy assignment would hide
  // non-transitive matches (A≈C and C≈B, while A≉B) from the audit evidence.
  const simhashGroups: SimHashGroup[] = [];
  let simhashGroupTotal = 0;
  for (let i = 0; i < snapshot.length; i++) {
    const seed = snapshot[i];
    for (let j = i + 1; j < snapshot.length; j++) {
      const candidate = snapshot[j];
      const distance = hammingDistance(seed.hash, candidate.hash);
      if (distance <= threshold) {
        simhashGroupTotal++;
        if (simhashGroups.length < DUPLICATE_EVIDENCE_LIMIT) {
          simhashGroups.push({
            seedId: seed.note.id,
            notes: [seed.note, candidate.note],
            evidence: [{ noteId: candidate.note.id, distanceFromSeed: distance }],
          });
        }
      }
    }
  }

  const hashedAtStart = snapshot.filter(item => item.hashSource === 'stored').length;
  const omissionReasons = incompleteness?.omissionReasons ?? {};
  const omitted = Object.values(omissionReasons).reduce((total, count) => total + count, 0);
  const indexedSnapshotUnsafe = incompleteness?.indexedSnapshotUnsafe === true;
  return {
    coverage: {
      eligible: snapshot.length + omitted,
      hashedAtStart,
      computedEphemerally: snapshot.length - hashedAtStart,
      evaluated: snapshot.length,
      omitted,
      omissionReasons,
      complete: omitted === 0 && !indexedSnapshotUnsafe,
    },
    titleGroups: indexedSnapshotUnsafe ? [] : titleGroups,
    simhashGroupTotal: indexedSnapshotUnsafe ? 0 : simhashGroupTotal,
    simhashGroups: indexedSnapshotUnsafe ? [] : simhashGroups,
    threshold,
  };
}
