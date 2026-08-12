import { createHash } from 'crypto';
import { cosineSimilarity } from './embeddings.js';
import { computeSimHash, hammingDistance } from './utils/simhash.js';
import type { Lifecycle, NoteKind, NoteStatus } from './types.js';

export const REVIEW_SERIALIZER_VERSION = 1;
export const DEFAULT_SIMHASH_THRESHOLD = 3;
export const DEFAULT_SEMANTIC_THRESHOLD = 0.85;

export interface ScreeningNote {
  id: string;
  title: string;
  normalizedTitle: string;
  content: string;
  summary: string;
  guidance: string;
  kind: NoteKind;
  status: NoteStatus;
  lifecycle: Lifecycle;
  tags: string[];
  related: string[];
  updatedAt: number;
  contentHash: string;
  hashSource: 'stored' | 'ephemeral';
  embedding?: number[];
  embeddingModel?: string;
}

export interface ScreeningSnapshot {
  schemaVersion: number;
  notes: ScreeningNote[];
}

export interface ScreeningCandidate {
  title: string;
  content: string;
  summary?: string;
  guidance?: string;
  kind: NoteKind;
  status: NoteStatus;
  lifecycle: Lifecycle;
  tags: string[];
  related?: string[];
  embedding?: number[];
  embeddingModel?: string;
}

export interface ScreeningMatch {
  id: string;
  updatedAt: number;
  title: string;
  lifecycle: Lifecycle;
  status: NoteStatus;
  kind: NoteKind;
  tags: string[];
  related: string[];
  exactTitle: boolean;
  simHashDistance: number;
  semanticSimilarity?: number;
  highConfidence: boolean;
}

export interface ScreeningEvaluation {
  candidateHash: string;
  matches: ScreeningMatch[];
  coverage: {
    notes: number;
    exactTitle: number;
    simHash: number;
    storedHashes: number;
    ephemeralHashes: number;
    semanticAvailable: number;
    semanticUnavailable: number;
  };
}

export function normalizeScreeningTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function evaluateScreeningCandidate(
  candidate: ScreeningCandidate,
  snapshot: ScreeningSnapshot,
  options: { simHashThreshold?: number; semanticThreshold?: number } = {},
): ScreeningEvaluation {
  const simHashThreshold = options.simHashThreshold ?? DEFAULT_SIMHASH_THRESHOLD;
  const semanticThreshold = options.semanticThreshold ?? DEFAULT_SEMANTIC_THRESHOLD;
  const candidateHash = computeSimHash(candidate.summary || candidate.content || candidate.title);
  const normalizedTitle = normalizeScreeningTitle(candidate.title);
  let semanticAvailable = 0;
  const matches = snapshot.notes.map((note): ScreeningMatch => {
    const distance = hammingDistance(candidateHash, note.contentHash);
    const exactTitle = normalizedTitle === note.normalizedTitle;
    let semanticSimilarity: number | undefined;
    if (candidate.embedding && note.embedding
      && candidate.embeddingModel !== undefined
      && candidate.embeddingModel === note.embeddingModel
      && candidate.embedding.length === note.embedding.length) {
      semanticSimilarity = cosineSimilarity(candidate.embedding, note.embedding);
      semanticAvailable++;
    }
    return {
      id: note.id,
      updatedAt: note.updatedAt,
      title: note.title,
      lifecycle: note.lifecycle,
      status: note.status,
      kind: note.kind,
      tags: [...note.tags],
      related: [...note.related],
      exactTitle,
      simHashDistance: distance,
      semanticSimilarity,
      highConfidence: exactTitle || distance <= simHashThreshold || (semanticSimilarity !== undefined && semanticSimilarity >= semanticThreshold),
    };
  }).sort((a, b) => Number(b.highConfidence) - Number(a.highConfidence) || Number(b.exactTitle) - Number(a.exactTitle) || a.simHashDistance - b.simHashDistance || a.id.localeCompare(b.id));

  return {
    candidateHash,
    matches,
    coverage: {
      notes: snapshot.notes.length,
      exactTitle: snapshot.notes.length,
      simHash: snapshot.notes.length,
      storedHashes: snapshot.notes.filter(note => note.hashSource === 'stored').length,
      ephemeralHashes: snapshot.notes.filter(note => note.hashSource === 'ephemeral').length,
      semanticAvailable,
      semanticUnavailable: snapshot.notes.length - semanticAvailable,
    },
  };
}

export function screeningEvidenceDigest(evaluation: ScreeningEvaluation): string {
  const canonical = {
    candidateHash: evaluation.candidateHash,
    coverage: evaluation.coverage,
    matches: evaluation.matches.map(match => ({
      id: match.id,
      updatedAt: match.updatedAt,
      title: match.title,
      lifecycle: match.lifecycle,
      status: match.status,
      kind: match.kind,
      tags: match.tags,
      related: match.related,
      exactTitle: match.exactTitle,
      simHashDistance: match.simHashDistance,
      semanticSimilarity: match.semanticSimilarity ?? null,
      highConfidence: match.highConfidence,
    })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function normalizedCandidate(candidate: ScreeningCandidate): Record<string, unknown> {
  return {
    title: candidate.title.trim().replace(/\r\n?/g, '\n'),
    content: candidate.content.replace(/\r\n?/g, '\n'),
    summary: (candidate.summary ?? '').trim().replace(/\r\n?/g, '\n'),
    guidance: (candidate.guidance ?? '').trim().replace(/\r\n?/g, '\n'),
    kind: candidate.kind,
    status: candidate.status,
    lifecycle: candidate.lifecycle,
    tags: [...new Set(candidate.tags)].sort(),
    related: [...new Set(candidate.related ?? [])],
  };
}

export function serializeReviewedOperation(input: {
  candidate: ScreeningCandidate;
  evaluation: ScreeningEvaluation;
  operation: 'create' | 'update';
  snapshotVersion: number;
  configVersion: string;
  modelIdentity?: string;
  target?: { id: string; updatedAt: number };
}): string {
  const highConfidenceMatches = input.evaluation.matches.filter(match => match.highConfidence).map(match => ({
    id: match.id,
    updatedAt: match.updatedAt,
    exactTitle: match.exactTitle,
    simHashDistance: match.simHashDistance,
    semanticSimilarity: match.semanticSimilarity ?? null,
  }));
  return JSON.stringify({
    version: REVIEW_SERIALIZER_VERSION,
    candidate: normalizedCandidate(input.candidate),
    operation: input.operation,
    target: input.target ?? null,
    snapshotVersion: input.snapshotVersion,
    configVersion: input.configVersion,
    modelIdentity: input.modelIdentity ?? '',
    evidenceDigest: screeningEvidenceDigest(input.evaluation),
    matches: highConfidenceMatches,
  });
}

export function reviewedOperationToken(input: Parameters<typeof serializeReviewedOperation>[0]): string {
  return createHash('sha256').update(serializeReviewedOperation(input)).digest('hex');
}

/** Build the effective update candidate used consistently by preview and apply tokens. */
export function reviewedUpdateCandidate(
  candidate: ScreeningCandidate,
  target: Pick<ScreeningNote, 'status' | 'lifecycle' | 'tags' | 'related'>,
  preserve: { tags: boolean; related: boolean },
): ScreeningCandidate {
  return {
    ...candidate,
    status: target.status,
    lifecycle: target.lifecycle,
    tags: preserve.tags ? [...target.tags] : candidate.tags,
    related: preserve.related ? [...target.related] : candidate.related,
  };
}

export function targetFirstComparator<T extends { id: string }>(targetId?: string): (a: T, b: T) => number {
  return (a, b) => {
    const aIsTarget = a.id === targetId;
    const bIsTarget = b.id === targetId;
    if (aIsTarget === bIsTarget) return 0;
    return aIsTarget ? -1 : 1;
  };
}

export function reviewedOperationTokens(input: Omit<Parameters<typeof serializeReviewedOperation>[0], 'operation' | 'target'> & {
  targetId?: string;
  updateCandidate?: (candidate: ScreeningCandidate, match: ScreeningEvaluation['matches'][number]) => ScreeningCandidate;
}): {
  createToken: string;
  updateTokens: Array<{ id: string; expectedUpdatedAt: number; token: string }>;
} {
  const { targetId, updateCandidate: buildUpdateCandidate, ...operationInput } = input;
  const scope = (tags: string[]) => tags
    .filter(tag => tag.startsWith('project:') || tag.startsWith('client:') || tag === 'scope:global')
    .sort();
  return {
    createToken: reviewedOperationToken({ ...operationInput, operation: 'create' }),
    updateTokens: operationInput.evaluation.matches
      .filter(match => (match.highConfidence || match.id === targetId)
        && match.status !== 'archived'
        && match.lifecycle !== 'snapshot'
        && match.kind === operationInput.candidate.kind
        && JSON.stringify(scope(match.tags)) === JSON.stringify(scope(operationInput.candidate.tags)))
      .sort(targetFirstComparator(targetId))
      .map(match => {
        const candidate = buildUpdateCandidate
          ? buildUpdateCandidate(operationInput.candidate, match)
          : { ...operationInput.candidate, status: match.status, lifecycle: match.lifecycle };
        return {
          id: match.id,
          expectedUpdatedAt: match.updatedAt,
          token: reviewedOperationToken({
            ...operationInput,
            candidate,
            operation: 'update',
            target: { id: match.id, updatedAt: match.updatedAt },
          }),
        };
      }),
  };
}
