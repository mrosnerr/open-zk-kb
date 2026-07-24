// registry.ts - Closed built-in rule registry for the internal vault-review core.
//
// Rule IDs use `<profile>.<name>` slugs (e.g. `lifecycle.review-due`). This
// module has no plugin/extension contract — see src/review/README.md.

import { canonicalFingerprint } from './fingerprint.js';
import type {
  EvaluationRequest,
  EvaluationResult,
  Evidence,
  Finding,
  FindingDraft,
  FindingGroup,
  NoteFacts,
  ResolutionCandidate,
  ReviewField,
  RuleMetadata,
  Scalar,
} from './types.js';

const DAY = 86_400_000;

export interface ReviewRule extends RuleMetadata {
  /** Ordering applied to facts before evaluation; each rule appends the source ordinal as a final deterministic tie-breaker. */
  readonly order: (a: NoteFacts, b: NoteFacts) => number;
  readonly evaluate: (facts: NoteFacts, request: EvaluationRequest) => readonly FindingDraft[];
}

const byOrdinal = (a: NoteFacts, b: NoteFacts): number => a.ordinal - b.ordinal;
const byNoteId = (a: NoteFacts, b: NoteFacts): number => a.note.id.localeCompare(b.note.id);

function noteFinding(
  message: string,
  facts: NoteFacts,
  fields: readonly ReviewField[] | undefined,
  evidence: readonly Evidence[],
  identity: readonly Scalar[],
  resolutions?: readonly ResolutionCandidate[],
): FindingDraft {
  return { primary: { id: facts.note.id, role: 'primary' }, fields, message, evidence, identity, resolutions };
}

// ---- lifecycle ----

const lifecycleReviewDue: ReviewRule = {
  id: 'lifecycle.review-due',
  version: 1,
  profile: 'lifecycle',
  impact: 'info',
  basis: 'heuristic',
  requiredFacts: ['status', 'staleDays', 'backlinks'],
  order: (a, b) => {
    const statusOrder = (a.note.status === 'fleeting' ? 0 : 1) - (b.note.status === 'fleeting' ? 0 : 1);
    if (statusOrder !== 0) return statusOrder;
    if (a.note.status === 'fleeting') {
      return a.backlinks - b.backlinks
        || a.note.access_count - b.note.access_count
        || a.note.created_at - b.note.created_at
        || byNoteId(a, b);
    }
    return a.backlinks - b.backlinks
      || a.note.created_at - b.note.created_at
      || byNoteId(a, b);
  },
  evaluate: (f, r) => {
    const policy = r.policy ?? {};
    const reviewAfterDays = policy.reviewAfterDays ?? 14;
    const archiveAfterDays = Math.max(1, policy.archiveAfterDays ?? 30);
    const promotionThreshold = policy.promotionThreshold ?? 3;

    const eligibleStatus = f.note.status === 'fleeting' || (f.note.status === 'permanent' && f.note.access_count === 0);
    if (!eligibleStatus) return [];
    // Exact review cutoff: created_at < now - days (mirrors NoteRepository.getReviewQueue's `n.created_at < ?`).
    if (!(f.note.created_at < r.now - reviewAfterDays * DAY)) return [];
    if ((policy.exemptKinds ?? []).includes(f.note.kind)) return [];
    if (f.note.status === 'permanent' && (f.note.kind === 'index' || f.note.kind === 'log')) return [];
    if (f.note.status === 'fleeting') {
      // Stale exclusion: last_accessed (or created) > cutoff — notes past the
      // archive cutoff belong to `lifecycle.stale-fleeting`, not this queue.
      const anchor = f.note.last_accessed_at ?? f.note.created_at;
      if (!(anchor > r.now - archiveAfterDays * DAY)) return [];
    }

    const accesses = f.note.access_count;
    const archiveSuggestionDays = Math.max(1, Math.floor(archiveAfterDays / 2));
    let action: 'promote' | 'archive' | 'review' = 'review';
    let rationale = `${f.staleDays} days old, ${accesses} accesses — needs manual review`;
    if (accesses >= promotionThreshold) {
      action = 'promote';
      rationale = `Accessed ${accesses} times (threshold: ${promotionThreshold})`;
    } else if (accesses === 0 && f.staleDays > archiveSuggestionDays && f.backlinks === 0) {
      action = 'archive';
      rationale = `Zero accesses, ${f.staleDays} days old, no backlinks — likely stale`;
    } else if (accesses === 0 && f.staleDays > archiveSuggestionDays) {
      rationale = `Zero accesses but ${f.backlinks} backlink(s) — referenced by other notes`;
    }

    return [
      noteFinding(
        'Note pending lifecycle review',
        f,
        ['title', 'content'],
        [
          { label: 'staleness', value: f.staleDays },
          { label: 'accesses', value: accesses },
          { label: 'backlinks', value: f.backlinks },
        ],
        [f.note.id, f.note.status],
        [{ id: action, label: action.toUpperCase(), rationale }],
      ),
    ];
  },
};

const lifecycleStaleFleeting: ReviewRule = {
  id: 'lifecycle.stale-fleeting',
  version: 1,
  profile: 'lifecycle',
  impact: 'warning',
  basis: 'heuristic',
  requiredFacts: ['status', 'staleDays'],
  // Retains current repository note order (source ordinal only) rather than re-sorting by staleness.
  order: byOrdinal,
  evaluate: (f, r) => {
    const archiveAfterDays = Math.max(1, r.policy?.archiveAfterDays ?? 30);
    if (f.note.status !== 'fleeting' || !(f.staleDays >= archiveAfterDays)) return [];
    return [noteFinding('Fleeting note is stale', f, ['title'], [{ label: 'staleDays', value: f.staleDays }], [f.note.id])];
  },
};

// ---- content / metadata ----

const contentOversized: ReviewRule = {
  id: 'content.oversized',
  version: 1,
  profile: 'content',
  impact: 'warning',
  basis: 'heuristic',
  requiredFacts: ['status', 'contentWords', 'wordGuidance'],
  order: (a, b) => b.contentWords - a.contentWords || byNoteId(a, b),
  evaluate: f => {
    if (f.note.status === 'archived' || !(f.contentWords > f.wordGuidance.warn)) return [];
    return [
      noteFinding(
        'Note may need splitting',
        f,
        ['content'],
        [{ label: 'words', value: f.contentWords }, { label: 'target', value: f.wordGuidance.target }],
        [f.note.id],
      ),
    ];
  },
};

const titleTooLong: ReviewRule = {
  id: 'title.too-long',
  version: 1,
  profile: 'content',
  impact: 'warning',
  basis: 'heuristic',
  requiredFacts: ['status', 'kind', 'titleWords'],
  // Legacy sort key is the untrimmed `title.split(/\s+/).length`; eligibility below still uses the trimmed count.
  order: (a, b) => b.titleWordsRaw - a.titleWordsRaw || byNoteId(a, b),
  evaluate: f => {
    if (f.note.status === 'archived' || f.note.kind === 'index' || f.note.kind === 'log') return [];
    if (!(f.titleWords > 6)) return [];
    return [noteFinding('Title exceeds six-word target', f, ['title'], [{ label: 'words', value: f.titleWords }], [f.note.id])];
  },
};

// ---- preference audit ----

const PREFERENCE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['temporary-wording', /\b(?:temporary|temporarily|for now|currently|this (?:session|task)|until (?:further notice|tomorrow|next week))\b/gi],
  ['exact-path', /(?<!\S)(?:[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]+|(?:~|\.{1,2})?\/(?:[\w.-]+\/)*[\w.-]+|\.[\w.-]+\/(?:[\w.-]+\/)*[\w.-]+)/gm],
  ['hex-color', /#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?\b/gi],
  ['model-identifier', /\b(?:gpt-?[34](?:[.\w-]*)?|claude-(?:\d|opus|sonnet|haiku)[\w.-]*|gemini-[\w.-]+|llama-?\d[\w.-]*)\b/gi],
  ['model-routing', /\b(?:route|routing|fallback|default model|model selection)\b/gi],
  ['configuration-language', /\b(?:configure|configured|configuration|set|install|implement|implementation|enable|disable)\b/gi],
];

const MISSING_APPLICABILITY_PATTERN = /\b(?:OpenCode|Claude Code|Cursor|Windsurf|Zed|VS Code|React|Next\.js|TypeScript|Python|Bun)\b/gi;

function collectEvidence(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)]
    .map(match => match[0].trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
}

function preferenceText(f: NoteFacts): string {
  return [f.note.title, f.note.summary, f.note.content, f.note.guidance].filter(Boolean).join('\n');
}

/** Preference rules select only non-archived personalization notes, matching the legacy detector's scan set. */
function isPreferenceEligible(f: NoteFacts): boolean {
  return f.note.kind === 'personalization' && f.note.status !== 'archived';
}

function preferenceRule(type: string, pattern: RegExp): ReviewRule {
  return {
    id: `preference.${type}`,
    version: 1,
    profile: 'preference',
    impact: 'info',
    basis: 'heuristic',
    requiredFacts: ['kind', 'status', 'title', 'summary', 'content', 'guidance'],
    order: byOrdinal,
    evaluate: f => {
      if (!isPreferenceEligible(f)) return [];
      const evidence = collectEvidence(preferenceText(f), pattern);
      if (evidence.length === 0) return [];
      return [
        noteFinding(
          `Preference signal: ${type}`,
          f,
          ['title', 'summary', 'content', 'guidance'],
          evidence.map(value => ({ label: 'match', value })),
          [f.note.id, type],
        ),
      ];
    },
  };
}

const preferenceMissingApplicability: ReviewRule = {
  id: 'preference.missing-applicability',
  version: 1,
  profile: 'preference',
  impact: 'info',
  basis: 'heuristic',
  requiredFacts: ['kind', 'status', 'tags', 'title', 'summary', 'content', 'guidance'],
  order: byOrdinal,
  evaluate: f => {
    if (!isPreferenceEligible(f)) return [];
    const hasApplicability = f.note.tags.some(tag => tag.startsWith('project:') || tag.startsWith('client:'));
    if (hasApplicability) return [];
    const evidence = collectEvidence(preferenceText(f), MISSING_APPLICABILITY_PATTERN);
    if (evidence.length === 0) return [];
    return [
      noteFinding(
        'Preference signal: missing-applicability',
        f,
        ['title', 'summary', 'content', 'guidance'],
        evidence.map(value => ({ label: 'match', value })),
        [f.note.id, 'missing-applicability'],
      ),
    ];
  },
};

// Detector-definition order, then missing-applicability last — matches `detectPreferenceAuditSignals`.
const preference: readonly ReviewRule[] = [
  ...PREFERENCE_PATTERNS.map(([type, pattern]) => preferenceRule(type, pattern)),
  preferenceMissingApplicability,
];

export const BUILTIN_RULES: readonly ReviewRule[] = [lifecycleReviewDue, lifecycleStaleFleeting, contentOversized, titleTooLong, ...preference];

export function finalizeFinding(rule: RuleMetadata, draft: FindingDraft): Finding {
  return {
    ...draft,
    ruleId: rule.id,
    ruleVersion: rule.version,
    impact: rule.impact,
    basis: rule.basis,
    fingerprint: canonicalFingerprint(rule.id, draft.identity),
  };
}

export function evaluateReview(
  request: EvaluationRequest,
  snapshot: readonly NoteFacts[],
): EvaluationResult {
  const selected = BUILTIN_RULES.filter(
    rule => (!request.profile || rule.profile === request.profile) && (!request.ruleIds || request.ruleIds.includes(rule.id)),
  );
  const groups: FindingGroup[] = selected.map(rule => {
    const findings = [...snapshot]
      .sort(rule.order)
      .flatMap(facts => rule.evaluate(facts, request).map(draft => finalizeFinding(rule, draft)));
    return { ruleId: rule.id, findings, total: findings.length };
  });
  return {
    profile: request.profile ?? 'default',
    scope: request.scope,
    groups,
    totals: Object.fromEntries(groups.map(g => [g.ruleId, g.total])),
  };
}
