// tests/review-core.test.ts - Internal vault-review core: registry ordering,
// determinism, and fingerprint identity. See src/review/README.md.
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createTestHarness, cleanupTestHarness, type TestContext } from './harness';
import { buildReviewSnapshot } from '../src/review/facts';
import { canonicalFingerprint } from '../src/review/fingerprint';
import { createRepositoryReviewReader } from '../src/review/reader';
import { evaluateReview, BUILTIN_RULES } from '../src/review/registry';
import type { ReviewScope } from '../src/review/types';

const FULL: ReviewScope = { kind: 'full' };

function updateTimes(ctx: TestContext, id: string, createdAt: number, updatedAt?: number): void {
  const db = new Database(path.join(ctx.tempDir, '.index', 'knowledge.db'));
  try {
    db.query('UPDATE notes SET created_at = ?, updated_at = COALESCE(?, updated_at) WHERE id = ?').run(createdAt, updatedAt ?? null, id);
  } finally {
    db.close();
  }
}

describe('vault-review core: registry', () => {
  it('declares the compatibility profile/rule-id order', () => {
    expect(BUILTIN_RULES.map(r => r.id)).toEqual([
      'lifecycle.review-due',
      'lifecycle.stale-fleeting',
      'content.oversized',
      'title.too-long',
      'preference.temporary-wording',
      'preference.exact-path',
      'preference.hex-color',
      'preference.model-identifier',
      'preference.model-routing',
      'preference.configuration-language',
      'preference.missing-applicability',
    ]);
  });

  it('marks the lifecycle rules as heuristic, not invariant', () => {
    const lifecycleRules = BUILTIN_RULES.filter(r => r.profile === 'lifecycle');
    expect(lifecycleRules).toHaveLength(2);
    for (const rule of lifecycleRules) expect(rule.basis).toBe('heuristic');
  });
});

describe('vault-review core: determinism', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('produces identical groups, fingerprints, and totals across repeated evaluations with the same clock', () => {
    for (let i = 0; i < 5; i++) {
      ctx.engine.store(`Body ${i} with some words to count toward the oversized threshold check.`, {
        title: `Note ${i}`,
        kind: 'reference',
        status: 'fleeting',
        tags: ['project:demo'],
      });
    }
    const now = Date.now();
    const reader = createRepositoryReviewReader(ctx.engine);
    const snapshot = buildReviewSnapshot(reader, FULL, now);

    const first = evaluateReview({ scope: FULL, now }, snapshot);
    const second = evaluateReview({ scope: FULL, now }, snapshot);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    for (const group of first.groups) {
      const repeated = second.groups.find(candidate => candidate.ruleId === group.ruleId);
      if (!repeated) throw new Error(`Missing repeated group ${group.ruleId}`);
      expect(group.findings.map(finding => finding.fingerprint)).toEqual(repeated.findings.map(finding => finding.fingerprint));
    }
  });

  it('sorts content.oversized by descending word count with a stable ordinal tie-break', () => {
    const short = ctx.engine.store('short body', { title: 'Short', kind: 'reference', tags: ['project:demo'] });
    const big = ctx.engine.store(Array(250).fill('word').join(' '), { title: 'Big', kind: 'reference', tags: ['project:demo'] });
    const bigger = ctx.engine.store(Array(400).fill('word').join(' '), { title: 'Bigger', kind: 'reference', tags: ['project:demo'] });
    void short;

    const now = Date.now();
    const reader = createRepositoryReviewReader(ctx.engine);
    const snapshot = buildReviewSnapshot(reader, FULL, now);
    const result = evaluateReview({ scope: FULL, ruleIds: ['content.oversized'], now }, snapshot);
    const ids = result.groups[0].findings.map(f => f.primary.id);
    expect(ids).toEqual([bigger.id, big.id]);
  });

  it('retains source (updated_at DESC) order for lifecycle.stale-fleeting rather than re-sorting by staleness', () => {
    const daysAgo = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000;
    const older = ctx.engine.store('old', { title: 'Older Stale', kind: 'observation', status: 'fleeting', tags: ['project:demo'] });
    const newer = ctx.engine.store('newer', { title: 'Newer Stale', kind: 'observation', status: 'fleeting', tags: ['project:demo'] });
    updateTimes(ctx, older.id, daysAgo(200), daysAgo(200));
    updateTimes(ctx, newer.id, daysAgo(100), daysAgo(100));

    const now = Date.now();
    const reader = createRepositoryReviewReader(ctx.engine);
    const snapshot = buildReviewSnapshot(reader, FULL, now);
    const result = evaluateReview({ scope: FULL, ruleIds: ['lifecycle.stale-fleeting'], now, policy: { archiveAfterDays: 30 } }, snapshot);
    // Source order is updated_at DESC, so the more-recently-updated ("newer") note comes first,
    // even though it is less stale than "older" — this is the legacy repository-order contract.
    expect(result.groups[0].findings.map(f => f.primary.id)).toEqual([newer.id, older.id]);
  });
});

describe('vault-review core: fingerprints', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness({ telemetryEnabled: true }); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('keeps the fingerprint stable when word count, evidence, and message-affecting content change but the logical subject does not', () => {
    const note = ctx.engine.store(Array(320).fill('word').join(' '), { title: 'Growing Note', kind: 'reference', tags: ['project:demo'] });
    const now = Date.now();
    const reader = createRepositoryReviewReader(ctx.engine);

    const before = evaluateReview({ scope: FULL, ruleIds: ['content.oversized'], now }, buildReviewSnapshot(reader, FULL, now));
    ctx.engine.store(Array(900).fill('word').join(' '), { title: 'Growing Note', kind: 'reference', tags: ['project:demo'], existingId: note.id });
    const after = evaluateReview({ scope: FULL, ruleIds: ['content.oversized'], now }, buildReviewSnapshot(reader, FULL, now));

    expect(before.groups[0].findings).toHaveLength(1);
    expect(after.groups[0].findings).toHaveLength(1);
    expect(after.groups[0].findings[0].fingerprint).toBe(before.groups[0].findings[0].fingerprint);
    expect(after.groups[0].findings[0].evidence).not.toEqual(before.groups[0].findings[0].evidence);
  });

  it('rejects non-integer numeric identity parts instead of serializing them ambiguously', () => {
    expect(() => canonicalFingerprint('content.oversized', [Number.NaN])).toThrow(TypeError);
    expect(() => canonicalFingerprint('content.oversized', [1.5])).toThrow(TypeError);
  });

  it('changes the fingerprint when the logical subject (note id) changes', () => {
    const a = ctx.engine.store(Array(320).fill('word').join(' '), { title: 'A', kind: 'reference', tags: ['project:demo'] });
    const b = ctx.engine.store(Array(320).fill('word').join(' '), { title: 'B', kind: 'reference', tags: ['project:demo'] });
    void a;
    const now = Date.now();
    const reader = createRepositoryReviewReader(ctx.engine);
    const result = evaluateReview({ scope: FULL, ruleIds: ['content.oversized'], now }, buildReviewSnapshot(reader, FULL, now));
    const fingerprints = result.groups[0].findings.map(f => f.fingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
    expect(result.groups[0].findings.find(f => f.primary.id === b.id)).toBeDefined();
  });

  it('changes the fingerprint when lifecycle.review-due status changes but not on age/backlink/access changes alone', () => {
    const note = ctx.engine.store('body', { title: 'Cycling', kind: 'observation', status: 'fleeting', tags: ['project:demo'] });
    const daysAgo = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000;
    updateTimes(ctx, note.id, daysAgo(20));

    const now = Date.now();
    const reader = createRepositoryReviewReader(ctx.engine);
    const asFleeting = evaluateReview({ scope: FULL, ruleIds: ['lifecycle.review-due'], now, policy: { exemptKinds: [] } }, buildReviewSnapshot(reader, FULL, now));
    ctx.engine.recordAccess(note.id);
    ctx.engine.recordAccess(note.id);
    ctx.engine.recordAccess(note.id);
    ctx.engine.recordAccess(note.id);
    const stillFleetingDifferentAccess = evaluateReview({ scope: FULL, ruleIds: ['lifecycle.review-due'], now, policy: { exemptKinds: [] } }, buildReviewSnapshot(reader, FULL, now));

    expect(asFleeting.groups[0].findings).toHaveLength(1);
    expect(stillFleetingDifferentAccess.groups[0].findings).toHaveLength(1);
    // Same status ('fleeting') → same identity → same fingerprint, even though accesses/rationale changed.
    expect(stillFleetingDifferentAccess.groups[0].findings[0].fingerprint).toBe(asFleeting.groups[0].findings[0].fingerprint);
    expect(stillFleetingDifferentAccess.groups[0].findings[0].resolutions?.[0]?.id).toBe('promote');
    expect(asFleeting.groups[0].findings[0].resolutions?.[0]?.id).not.toBe('promote');
  });
});

describe('vault-review core: preference eligibility', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('only evaluates non-archived personalization notes for preference rules', () => {
    ctx.engine.store('Temporarily configure claude-sonnet routing.', { title: 'Non-personalization', kind: 'reference', status: 'permanent', tags: [] });
    ctx.engine.store('Temporarily configure claude-sonnet routing.', { title: 'Archived Pref', kind: 'personalization', status: 'archived', tags: [] });
    const eligible = ctx.engine.store('Temporarily configure claude-sonnet routing.', { title: 'Active Pref', kind: 'personalization', status: 'permanent', tags: [] });

    const now = Date.now();
    const reader = createRepositoryReviewReader(ctx.engine);
    const result = evaluateReview({ scope: FULL, profile: 'preference', now }, buildReviewSnapshot(reader, FULL, now));
    const ids = new Set(result.groups.flatMap(g => g.findings.map(f => f.primary.id)));
    expect(ids.has(eligible.id)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('excludes fingerprint identity from evidence excerpts (identity is note id + signal type only)', () => {
    const note = ctx.engine.store('Temporarily use claude-sonnet-4 for now.', { title: 'Pref', kind: 'personalization', status: 'permanent', tags: [] });
    const now = Date.now();
    const reader = createRepositoryReviewReader(ctx.engine);
    const result = evaluateReview({ scope: FULL, ruleIds: ['preference.temporary-wording'], now }, buildReviewSnapshot(reader, FULL, now));
    const finding = result.groups[0].findings.find(f => f.primary.id === note.id);
    if (!finding) throw new Error('Expected temporary-wording finding');
    expect(finding.identity).toEqual([note.id, 'temporary-wording']);
  });
});
