import type { KnowledgeApplicability } from '../knowledge-scope.js';
import type { Lifecycle, NoteKind, NoteStatus } from '../types.js';

/**
 * Execution scope for an evaluation. `full` is unrestricted maintenance
 * visibility (every note, every project). `project` is the canonical
 * project/client-visible scope: global/universal-client semantics apply and
 * unclassified notes fail closed (see `NoteRepository.visibilityPredicate`).
 */
export type ReviewScope = Readonly<{ kind: 'full' } | { kind: 'project'; project: string; client?: string }>;

export type Impact = 'info' | 'warning' | 'error';
export type EvidenceBasis = 'invariant' | 'heuristic' | 'semantic';
export type ReviewField = 'title' | 'summary' | 'content' | 'guidance' | 'tags';
export type Scalar = string | number | boolean;

export interface RuleMetadata {
  readonly id: string;
  readonly version: number;
  readonly profile: string;
  readonly impact: Impact;
  readonly basis: EvidenceBasis;
  readonly requiredFacts: readonly string[];
}

export interface NoteSubject {
  readonly id: string;
  readonly role: 'primary' | 'related';
}

export interface Evidence {
  readonly label: string;
  readonly value: Scalar;
  readonly excerpt?: string;
}

export interface ResolutionCandidate {
  readonly id: string;
  readonly label: string;
  readonly rationale: string;
}

/**
 * A rule's raw output before the engine attaches identity/impact/basis.
 * `identity` is the logical-subject tuple used for fingerprinting: it must
 * be restricted to note identity plus the minimal state/signal needed to
 * distinguish findings — never evidence, excerpts, ages, or word counts.
 */
export interface FindingDraft {
  readonly primary: NoteSubject;
  readonly related?: readonly NoteSubject[];
  readonly fields?: readonly ReviewField[];
  readonly message: string;
  readonly evidence: readonly Evidence[];
  readonly resolutions?: readonly ResolutionCandidate[];
  readonly identity: readonly Scalar[];
}

export interface Finding extends FindingDraft {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly fingerprint: string;
  readonly impact: Impact;
  readonly basis: EvidenceBasis;
}

export interface EvaluationRequest {
  readonly scope: ReviewScope;
  readonly profile?: string;
  readonly ruleIds?: readonly string[];
  readonly now: number;
  readonly limit?: number;
  readonly policy?: Readonly<{
    reviewAfterDays?: number;
    archiveAfterDays?: number;
    promotionThreshold?: number;
    exemptKinds?: readonly NoteKind[];
  }>;
}

export interface FindingGroup {
  readonly ruleId: string;
  readonly findings: readonly Finding[];
  readonly total: number;
}

export interface EvaluationResult {
  readonly profile: string;
  readonly scope: ReviewScope;
  readonly groups: readonly FindingGroup[];
  readonly totals: Readonly<Record<string, number>>;
}

/** Per-kind word-count guidance resolved for a note; `'?'` mirrors the legacy display fallback for unknown kinds. */
export interface WordGuidance {
  readonly target: number | '?';
  readonly warn: number;
}

export interface NoteFacts {
  readonly ordinal: number;
  readonly note: Readonly<{
    id: string;
    title: string;
    kind: NoteKind;
    status: NoteStatus;
    lifecycle: Lifecycle;
    tags: readonly string[];
    content: string;
    summary?: string;
    guidance?: string;
    created_at: number;
    updated_at: number;
    access_count: number;
    last_accessed_at?: number;
    word_count: number;
  }>;
  readonly applicability: KnowledgeApplicability;
  /** Whole days since creation, floored. Used only for display parity with legacy `daysOld` fields keyed off creation. */
  readonly ageDays: number;
  /** Whole days since last access (or creation if never accessed), floored and clamped to >= 0 — matches `computeStaleness`. */
  readonly staleDays: number;
  readonly backlinks: number;
  readonly contentWords: number;
  readonly titleWords: number;
  /** Non-trimmed `title.split(/\s+/).length` — preserved only to reproduce the legacy long-title sort key exactly. */
  readonly titleWordsRaw: number;
  readonly wordGuidance: WordGuidance;
}

export type ReviewSnapshot = readonly NoteFacts[];
