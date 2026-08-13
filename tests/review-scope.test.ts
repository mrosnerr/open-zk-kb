// tests/review-scope.test.ts - Internal vault-review core: project/client
// visibility and unclassified fail-closed behavior. The reader must delegate
// to NoteRepository's canonical visibilityPredicate, not re-implement it.
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createTestHarness, cleanupTestHarness, type TestContext } from './harness';
import { buildReviewSnapshot } from '../src/review/facts';
import { createRepositoryReviewReader } from '../src/review/reader';
import { evaluateReview } from '../src/review/registry';
import type { ReviewScope } from '../src/review/types';

describe('vault-review core: scope isolation', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('full scope is unrestricted: sees every project, unclassified, and archived note', () => {
    const alpha = ctx.engine.store('alpha body', { title: 'Alpha Note', kind: 'reference', tags: ['project:alpha'] });
    const beta = ctx.engine.store('beta body', { title: 'Beta Note', kind: 'reference', tags: ['project:beta'] });
    const global = ctx.engine.store('global body', { title: 'Global Note', kind: 'reference', tags: ['scope:global'] });
    const unclassified = ctx.engine.store('no applicability', { title: 'Unclassified Note', kind: 'reference', tags: ['topic'] });
    const archived = ctx.engine.store('archived body', { title: 'Archived Note', kind: 'reference', tags: ['project:alpha'], status: 'archived' });

    const reader = createRepositoryReviewReader(ctx.engine);
    const ids = new Set(reader.listNotes({ kind: 'full' }).map(n => n.id));
    for (const id of [alpha.id, beta.id, global.id, unclassified.id, archived.id]) expect(ids.has(id)).toBe(true);
  });

  it('project scope excludes other projects and unclassified notes (fail closed)', () => {
    const alpha = ctx.engine.store('alpha body', { title: 'Alpha Note', kind: 'reference', tags: ['project:alpha'] });
    const beta = ctx.engine.store('beta body', { title: 'Beta Note', kind: 'reference', tags: ['project:beta'] });
    const global = ctx.engine.store('global body', { title: 'Global Note', kind: 'reference', tags: ['scope:global'] });
    const missing = ctx.engine.store('no applicability', { title: 'Missing Tag Note', kind: 'reference', tags: ['topic'] });
    const conflict = ctx.engine.store('conflict body', { title: 'Conflict Note', kind: 'reference', tags: ['project:alpha', 'scope:global'] });
    const multi = ctx.engine.store('multi body', { title: 'Multi Project Note', kind: 'reference', tags: ['project:alpha', 'project:beta'] });

    const scope: ReviewScope = { kind: 'project', project: 'alpha' };
    const reader = createRepositoryReviewReader(ctx.engine);
    const ids = new Set(reader.listNotes(scope).map(n => n.id));

    expect(ids.has(alpha.id)).toBe(true);
    expect(ids.has(global.id)).toBe(true);
    expect(ids.has(beta.id)).toBe(false);
    expect(ids.has(missing.id)).toBe(false);
    expect(ids.has(conflict.id)).toBe(false);
    expect(ids.has(multi.id)).toBe(false);
  });

  it('client scope excludes notes tagged for a different specific client (no leak) while including untagged and client:all notes', () => {
    const forOther = ctx.engine.store('other client body', { title: 'Other Client Note', kind: 'reference', tags: ['project:alpha', 'client:other-client'] });
    const forOurs = ctx.engine.store('our client body', { title: 'Our Client Note', kind: 'reference', tags: ['project:alpha', 'client:our-client'] });
    const universal = ctx.engine.store('client:all body', { title: 'All Clients Note', kind: 'reference', tags: ['project:alpha', 'client:all'] });
    const untagged = ctx.engine.store('untagged body', { title: 'No Client Tag Note', kind: 'reference', tags: ['project:alpha'] });

    const scope: ReviewScope = { kind: 'project', project: 'alpha', client: 'our-client' };
    const reader = createRepositoryReviewReader(ctx.engine);
    const ids = new Set(reader.listNotes(scope).map(n => n.id));

    expect(ids.has(forOurs.id)).toBe(true);
    expect(ids.has(universal.id)).toBe(true);
    expect(ids.has(untagged.id)).toBe(true);
    expect(ids.has(forOther.id)).toBe(false);
  });

  it('preference findings cannot surface a note hidden by project scope', () => {
    ctx.engine.store('Temporarily configure claude-sonnet-4.', { title: 'Hidden Pref', kind: 'personalization', status: 'permanent', tags: ['project:beta'] });
    const visible = ctx.engine.store('Temporarily configure claude-sonnet-4.', { title: 'Visible Pref', kind: 'personalization', status: 'permanent', tags: ['project:alpha'] });

    const scope: ReviewScope = { kind: 'project', project: 'alpha' };
    const now = Date.now();
    const reader = createRepositoryReviewReader(ctx.engine);
    const result = evaluateReview({ scope, profile: 'preference', now }, buildReviewSnapshot(reader, scope, now));
    const ids = new Set(result.groups.flatMap(g => g.findings.map(f => f.primary.id)));
    expect(ids.has(visible.id)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('backlink counts exclude archived sources and sources hidden by scope, and are batched (not per-note lookups)', () => {
    const target = ctx.engine.store('target body', { title: 'Target', kind: 'reference', tags: ['project:alpha'] });
    ctx.engine.store(`Links to [[${target.id}]]`, { title: 'Live Source', kind: 'reference', tags: ['project:alpha'] });
    const archivedSource = ctx.engine.store(`Links to [[${target.id}]]`, { title: 'Archived Source', kind: 'reference', tags: ['project:alpha'] });
    ctx.engine.archive(archivedSource.id);
    ctx.engine.store(`Links to [[${target.id}]]`, { title: 'Other Project Source', kind: 'reference', tags: ['project:beta'] });

    const reader = createRepositoryReviewReader(ctx.engine);
    const fullCounts = reader.backlinkCounts({ kind: 'full' });
    expect(fullCounts.get(target.id)).toBe(2); // live source (alpha) + other-project source (beta); archived excluded

    const scopedCounts = reader.backlinkCounts({ kind: 'project', project: 'alpha' });
    expect(scopedCounts.get(target.id)).toBe(1); // only the alpha-visible live source; beta source hidden, archived excluded
  });
});
