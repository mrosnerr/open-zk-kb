import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NoteRepository } from '../src/storage/NoteRepository.js';
import { handleStore, type StoreArgs } from '../src/tool-handlers.js';
import { cleanupTestHarness, createTestHarness, listAllNoteFiles, type TestContext } from './harness.js';

function args(overrides: Partial<StoreArgs> = {}): StoreArgs {
  return {
    title: 'Canonical memory',
    content: 'durable canonical content',
    kind: 'reference',
    summary: 'Durable canonical summary.',
    guidance: 'Use the canonical memory.',
    project: 'demo',
    ...overrides,
  };
}

function parsed(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

function storedId(output: string): string {
  const id = /→\s*(\d{16})/.exec(output)?.[1];
  if (!id) throw new Error(`Expected stored note ID in: ${output}`);
  return id;
}

function getNote(ctx: TestContext, id: string) {
  const note = ctx.engine.getById(id);
  if (!note) throw new Error(`Expected note ${id}`);
  return note;
}

describe('reviewed knowledge-store handler', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness({ telemetryEnabled: false }); });
  afterEach(() => cleanupTestHarness(ctx));

  it('keeps low-risk legacy create one-call compatible', async () => {
    const output = await handleStore(args(), ctx.engine, null, ctx.config);
    expect(output).toContain('Stored reference: "Canonical memory"');
    expect(ctx.engine.getScreeningSnapshot({ project: 'demo' }).notes).toHaveLength(1);
  });

  it('returns mutation-free evidence and operation-specific tokens for a collision', async () => {
    await handleStore(args(), ctx.engine, null, ctx.config);
    const before = ctx.engine.getScreeningSnapshot({ project: 'demo' });
    const beforeFiles = listAllNoteFiles(ctx);
    const review = parsed(await handleStore(args({ content: 'replacement content' }), ctx.engine, null, ctx.config));
    expect(review.mutated).toBe(false);
    expect(review.state).toBe('review-required');
    expect(typeof review.createToken).toBe('string');
    expect(review.updateTokens).toBeArray();
    expect((review.updateTokens as unknown[]).length).toBe(1);
    expect(ctx.engine.getScreeningSnapshot({ project: 'demo' })).toEqual(before);
    expect(listAllNoteFiles(ctx)).toEqual(beforeFiles);
  });

  it('allows an explicitly reviewed duplicate-looking create and rejects a wrong-operation token', async () => {
    await handleStore(args(), ctx.engine, null, ctx.config);
    const candidate = args({ content: 'reviewed parallel content' });
    const review = parsed(await handleStore(candidate, ctx.engine, null, ctx.config));
    const updateToken = (review.updateTokens as Array<{ token: string }>)[0].token;
    const wrong = await handleStore({ ...candidate, disposition: 'create', confirm: true, token: updateToken }, ctx.engine, null, ctx.config);
    expect(wrong).toContain('token is stale or does not match');
    expect(ctx.engine.getScreeningSnapshot({ project: 'demo' }).notes).toHaveLength(1);

    const created = await handleStore({ ...candidate, disposition: 'create', confirm: true, token: review.createToken as string }, ctx.engine, null, ctx.config);
    expect(created).toContain('Stored reference');
    expect(ctx.engine.getScreeningSnapshot({ project: 'demo' }).notes).toHaveLength(2);
  });

  it('updates a visible living note while preserving protected metadata and related links', async () => {
    const related = await handleStore(args({ title: 'Related memory', content: 'related content', summary: 'Related summary.' }), ctx.engine, null, ctx.config);
    const relatedId = storedId(related);
    const created = await handleStore(args({ tags: ['topic'], related: [relatedId] }), ctx.engine, null, ctx.config);
    const id = storedId(created);
    const target = getNote(ctx, id);

    const updateArgs = args({
      title: 'Renamed canonical memory',
      content: 'updated durable canonical content',
      tags: ['replacement'],
      disposition: 'update',
      noteId: id,
      expectedUpdatedAt: target?.updated_at,
      dryRun: true,
    });
    const preview = parsed(await handleStore(updateArgs, ctx.engine, null, ctx.config));
    const updateToken = (preview.updateTokens as Array<{ id: string; token: string }>).find(item => item.id === id)?.token;
    expect(updateToken).toBeDefined();
    const output = await handleStore({ ...updateArgs, dryRun: false, confirm: true, token: updateToken }, ctx.engine, null, ctx.config);
    expect(output).toContain('Updated reference');
    const updated = ctx.engine.getById(id);
    expect(updated?.content).toContain('updated durable canonical content');
    expect(updated?.title).toBe('Renamed canonical memory');
    expect(updated?.tags).toContain('replacement');
    expect(updated?.tags).not.toContain('topic');
    expect(ctx.engine.getScreeningSnapshot({ project: 'demo' }).notes.find(note => note.id === id)?.related).toEqual([relatedId]);
    expect(updated?.created_at).toBe(target?.created_at);
    expect(updated?.path).toBe(target?.path);
    expect(updated?.content.match(/## Related/g)?.length).toBe(1);
  });

  it('rejects stale, hidden, archived, snapshot, and protected-field updates without mutation', async () => {
    const created = await handleStore(args(), ctx.engine, null, ctx.config);
    const id = storedId(created);
    const target = getNote(ctx, id);
    const base = args({ content: 'new content', disposition: 'update', noteId: id, expectedUpdatedAt: target.updated_at, dryRun: true });
    const preview = parsed(await handleStore(base, ctx.engine, null, ctx.config));
    const token = (preview.updateTokens as Array<{ token: string }>)[0].token;
    ctx.engine.store('concurrent content', { existingId: id, title: target.title, kind: target.kind, status: target.status, lifecycle: target.lifecycle, tags: target.tags, summary: target.summary, guidance: target.guidance });
    const stale = await handleStore({ ...base, dryRun: false, confirm: true, token }, ctx.engine, null, ctx.config);
    expect(stale).toContain('version is stale');
    expect(ctx.engine.getById(id)?.content).toBe('concurrent content');

    const hidden = await handleStore(args({ disposition: 'update', noteId: id, project: 'other', expectedUpdatedAt: target.updated_at, confirm: true, token: 'x' }), ctx.engine, null, ctx.config);
    expect(hidden).toContain('not active and visible');

    const snapshot = ctx.engine.store('snapshot content', { title: 'Snapshot target', kind: 'observation', status: 'fleeting', lifecycle: 'snapshot', tags: ['project:demo'], summary: 'Snapshot.', guidance: 'Keep snapshot.' });
    const snapshotResult = await handleStore(args({ kind: 'observation', title: 'Snapshot target', disposition: 'update', noteId: snapshot.id, expectedUpdatedAt: ctx.engine.getById(snapshot.id)?.updated_at, confirm: true, token: 'x' }), ctx.engine, null, ctx.config);
    expect(snapshotResult).toContain('lifecycle is immutable');

    ctx.engine.archive(id);
    const archived = await handleStore(args({ disposition: 'update', noteId: id, expectedUpdatedAt: ctx.engine.getById(id)?.updated_at, confirm: true, token: 'x' }), ctx.engine, null, ctx.config);
    expect(archived).toContain('not active and visible');
  });

  it('accepts only a metadata-preserving append-only content extension', async () => {
    const linked = ctx.engine.store('linked content', { title: 'Append related target', kind: 'reference', status: 'fleeting', lifecycle: 'living', tags: ['project:demo'], summary: 'Linked summary.', guidance: 'Keep linked.' });
    const note = ctx.engine.store('first line', { title: 'Append target', kind: 'reference', status: 'fleeting', lifecycle: 'append-only', tags: ['project:demo'], related: [linked.id], summary: 'Append summary.', guidance: 'Append safely.' });
    const target = getNote(ctx, note.id);
    const candidate = args({
      title: target.title, content: 'first line\nsecond line', summary: target.summary, guidance: target.guidance,
      disposition: 'update', noteId: note.id, expectedUpdatedAt: target.updated_at, dryRun: true,
    });
    const preview = parsed(await handleStore(candidate, ctx.engine, null, ctx.config));
    const updateToken = (preview.updateTokens as Array<{ token: string }>)[0].token;
    const updated = await handleStore({ ...candidate, dryRun: false, confirm: true, token: updateToken }, ctx.engine, null, ctx.config);
    expect(updated).toContain('Updated reference');
    expect(ctx.engine.getById(note.id)?.content).toContain('first line\nsecond line');
    expect(ctx.engine.getScreeningSnapshot({ project: 'demo' }).notes.find(item => item.id === note.id)?.related).toEqual([linked.id]);

    const current = getNote(ctx, note.id);
    const whitespace = args({
      title: current.title, content: 'first line\nsecond line   ', summary: current.summary, guidance: current.guidance,
      disposition: 'update', noteId: note.id, expectedUpdatedAt: current.updated_at, dryRun: true,
    });
    const whitespacePreview = parsed(await handleStore(whitespace, ctx.engine, null, ctx.config));
    const whitespaceToken = (whitespacePreview.updateTokens as Array<{ token: string }>)[0].token;
    const rejected = await handleStore({ ...whitespace, dryRun: false, confirm: true, token: whitespaceToken }, ctx.engine, null, ctx.config);
    expect(rejected).toContain('metadata-preserving content extension');
  });

  it('queues a public store behind an awaiting holder from another repository instance', async () => {
    const second = new NoteRepository(ctx.tempDir);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let acquired!: () => void;
    const entered = new Promise<void>(resolve => { acquired = resolve; });
    const holder = ctx.engine.withKnowledgeMutationLockAsync(async () => {
      acquired();
      await barrier;
    });
    await entered;
    let settled = false;
    const pendingStore = handleStore(args({ title: 'Queued memory' }), second, null, ctx.config)
      .finally(() => { settled = true; });
    await Bun.sleep(10);
    expect(settled).toBe(false);
    release();
    await holder;
    expect(await pendingStore).toContain('Stored reference: "Queued memory"');
    second.close();
  });

  it('releases the lock and preserves rebuild recovery after an accepted filesystem failure', async () => {
    const original = await handleStore(args(), ctx.engine, null, ctx.config);
    const originalId = storedId(original);
    const originalNote = getNote(ctx, originalId);
    const candidate = args({ content: 'reviewed content that will fail to write' });
    const preview = parsed(await handleStore(candidate, ctx.engine, null, ctx.config));
    const directory = path.dirname(originalNote.path);
    fs.chmodSync(directory, 0o500);
    let failed: string;
    try {
      failed = await handleStore({ ...candidate, disposition: 'create', confirm: true, token: preview.createToken as string }, ctx.engine, null, ctx.config);
    } finally {
      fs.chmodSync(directory, 0o700);
    }
    expect(failed).toContain('Error:');
    ctx.engine.rebuildFromFiles();
    expect(ctx.engine.getScreeningSnapshot({ project: 'demo' }).notes.filter(note => note.title === candidate.title)).toHaveLength(1);
    const recovered = await handleStore(args({ title: 'Post Recovery Note', content: 'post recovery content', summary: 'Post recovery summary.' }), ctx.engine, null, ctx.config);
    expect(recovered).toContain('Stored reference');
  });

  it('serializes independent process create and update races', async () => {
    const fixture = path.resolve(import.meta.dir, 'fixtures/reviewed-store-race.ts');
    const runRace = async (mode: 'create' | 'update', targetId?: string, expectedUpdatedAt?: number) => {
      const barrier = path.join(ctx.tempDir, `${mode}-barrier`);
      const processes = ['a', 'b'].map(lane => Bun.spawn([
        'bun', 'run', fixture, ctx.tempDir, mode, lane, barrier, targetId ?? '', expectedUpdatedAt?.toString() ?? '',
      ], { cwd: path.resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' }));
      for (let attempt = 0; attempt < 500; attempt++) {
        if (['a', 'b'].every(lane => fs.existsSync(`${barrier}.${lane}.ready`))) break;
        await Bun.sleep(2);
      }
      expect(['a', 'b'].every(lane => fs.existsSync(`${barrier}.${lane}.ready`))).toBe(true);
      fs.writeFileSync(barrier, 'go');
      const exitCodes = await Promise.all(processes.map(process => process.exited));
      expect(exitCodes).toEqual([0, 0]);
      return ['a', 'b'].map(lane => fs.readFileSync(`${barrier}.${lane}.result`, 'utf8'));
    };

    const createResults = await runRace('create');
    expect(createResults.filter(result => result.includes('Stored reference'))).toHaveLength(1);
    expect(createResults.filter(result => result.includes('token is stale'))).toHaveLength(1);
    expect(ctx.engine.getScreeningSnapshot({ project: 'race' }).notes.filter(note => note.title === 'Cross Process Candidate')).toHaveLength(1);

    const target = ctx.engine.store('initial target', { title: 'Cross Process Target', kind: 'reference', status: 'fleeting', lifecycle: 'living', tags: ['project:race'], summary: 'Initial target.', guidance: 'Use initial target.' });
    const targetMetadata = getNote(ctx, target.id);
    const updateResults = await runRace('update', target.id, targetMetadata.updated_at);
    expect(updateResults.filter(result => result.includes('Updated reference'))).toHaveLength(1);
    expect(updateResults.filter(result => result.includes('version is stale'))).toHaveLength(1);
  });

  it('rejects an old reviewed create after low-confidence visible evidence changes', async () => {
    const candidate = args();
    const preview = parsed(await handleStore({ ...candidate, dryRun: true }, ctx.engine, null, ctx.config));
    ctx.engine.store('unrelated visible evidence', { title: 'Unrelated Evidence', kind: candidate.kind, status: 'fleeting', lifecycle: 'living', tags: ['project:demo'], summary: 'Unrelated evidence summary.', guidance: 'Keep unrelated evidence.' });
    const stale = await handleStore({ ...candidate, disposition: 'create', confirm: true, token: preview.createToken as string }, ctx.engine, null, ctx.config);
    expect(stale).toContain('token is stale');
    expect(ctx.engine.getScreeningSnapshot({ project: 'demo' }).notes).toHaveLength(1);
  });

  it('rejects an old reviewed update after unrelated visible evidence changes', async () => {
    const created = await handleStore(args(), ctx.engine, null, ctx.config);
    const id = storedId(created);
    const target = getNote(ctx, id);
    const update = args({ title: 'Entirely Revised Canonical', content: 'entirely revised durable content', disposition: 'update', noteId: id, expectedUpdatedAt: target.updated_at, dryRun: true });
    const preview = parsed(await handleStore(update, ctx.engine, null, ctx.config));
    const token = (preview.updateTokens as Array<{ id: string; token: string }>).find(item => item.id === id)?.token;
    expect(token).toBeDefined();
    ctx.engine.store('another unrelated visible note', { title: 'Another Visible Note', kind: 'reference', status: 'fleeting', lifecycle: 'living', tags: ['project:demo'], summary: 'Another visible summary.', guidance: 'Keep another visible note.' });
    const stale = await handleStore({ ...update, dryRun: false, confirm: true, token }, ctx.engine, null, ctx.config);
    expect(stale).toContain('token is stale');
    expect(ctx.engine.getById(id)?.content).toBe(target.content);
  });
});
