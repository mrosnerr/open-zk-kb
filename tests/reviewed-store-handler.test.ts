import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NoteRepository } from '../src/storage/NoteRepository.js';
import { handleGet, handleStore, type StoreArgs } from '../src/tool-handlers.js';
import { computeSimHash } from '../src/utils/simhash.js';
import { evaluateScreeningCandidate, reviewedOperationTokens, reviewedUpdateCandidate, type ScreeningCandidate } from '../src/reviewed-storage.js';
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

  it('keeps an explicit low-confidence target and its token ahead of a capped preview', async () => {
    const target = ctx.engine.store('unrelated target body', {
      title: 'Unrelated target', kind: 'reference', status: 'fleeting', lifecycle: 'living',
      tags: ['project:demo'], summary: 'Unrelated target summary.', guidance: 'Keep unrelated target.',
    });
    for (let index = 0; index < 21; index++) {
      ctx.engine.store(`qualifying body ${index}`, {
        title: 'Crowded preview candidate', kind: 'reference', status: 'fleeting', lifecycle: 'living',
        tags: ['project:demo'], summary: `Qualifying summary ${index}.`, guidance: 'Keep qualifying evidence.',
      });
    }

    const updateArgs = args({
      title: 'Crowded preview candidate', content: 'candidate body unlike the explicit target',
      disposition: 'update', noteId: target.id, expectedUpdatedAt: getNote(ctx, target.id).updated_at, dryRun: true,
    });
    const snapshot = ctx.engine.getScreeningSnapshot({ project: 'demo' });
    const evaluation = evaluateScreeningCandidate({
      title: updateArgs.title, content: updateArgs.content, summary: updateArgs.summary,
      guidance: updateArgs.guidance, kind: 'reference', status: 'fleeting', lifecycle: 'living',
      tags: ['project:demo'], related: [],
    }, snapshot);
    const expectedNonTargets = evaluation.matches.filter(match => match.id !== target.id).map(match => match.id);
    expect(evaluation.matches.find(match => match.id === target.id)?.highConfidence).toBe(false);

    const preview = parsed(await handleStore(updateArgs, ctx.engine, null, ctx.config));
    const evidence = preview.evidence as { matches: Array<{ id: string }> };
    const tokens = preview.updateTokens as Array<{ id: string }>;
    expect(evidence.matches).toHaveLength(20);
    expect(tokens).toHaveLength(20);
    expect(evidence.matches[0].id).toBe(target.id);
    expect(tokens[0].id).toBe(target.id);
    expect(evidence.matches.slice(1).map(match => match.id)).toEqual(expectedNonTargets.slice(0, 19));
    expect(tokens.slice(1).map(token => token.id)).toEqual(expectedNonTargets.slice(0, 19));
  });

  it('fails closed when high-confidence create evidence becomes unavailable', async () => {
    const created = await handleStore(args(), ctx.engine, null, ctx.config);
    const id = storedId(created);
    const target = getNote(ctx, id);
    const candidate = args({ content: 'reviewed parallel content' });
    const available = parsed(await handleStore(candidate, ctx.engine, null, ctx.config));
    const token = available.createToken as string;
    fs.unlinkSync(target.path);

    const preview = parsed(await handleStore(candidate, ctx.engine, null, ctx.config));
    expect(preview.createToken).toBeUndefined();
    expect(preview.validDispositions).not.toContain('create');
    const rejected = await handleStore({ ...candidate, disposition: 'create', confirm: true, token }, ctx.engine, null, ctx.config);
    expect(rejected).toContain('create evidence is unavailable');
    expect(ctx.engine.getScreeningSnapshot({ project: 'demo' }).notes).toHaveLength(1);
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
    expect(updated?.content).not.toContain('## Related');
    const canonical = fs.readFileSync(getNote(ctx, id).path, 'utf-8');
    expect(canonical.match(/<!-- zk:related -->/g)).toHaveLength(1);
    expect(canonical.match(/^## Related$/gm)).toHaveLength(1);
  });

  it('strips generated Related sections for append-only content at the start or after body text', async () => {
    const linked = ctx.engine.store('linked content', { title: 'Related append target', kind: 'reference', status: 'fleeting', lifecycle: 'living', tags: ['project:demo'], summary: 'Linked summary.', guidance: 'Keep linked.' });
    for (const [title, content] of [['Body plus Related', 'body'], ['Related only', '']] as const) {
      const note = ctx.engine.store(content, { title, kind: 'reference', status: 'fleeting', lifecycle: 'append-only', tags: ['project:demo'], related: [linked.id], summary: 'Append summary.', guidance: 'Append safely.' });
      const target = getNote(ctx, note.id);
      const candidate = args({ title, content: `${content} appended`, summary: target.summary, guidance: target.guidance, disposition: 'update', noteId: note.id, expectedUpdatedAt: target.updated_at, dryRun: true });
      const preview = parsed(await handleStore(candidate, ctx.engine, null, ctx.config));
      const token = (preview.updateTokens as Array<{ token: string }>).find(item => item.id === note.id)?.token;
      expect(await handleStore({ ...candidate, dryRun: false, confirm: true, token }, ctx.engine, null, ctx.config)).toContain('Updated reference');
      expect(ctx.engine.getGeneratedRelatedIds(note.id)).toEqual([linked.id]);
      const canonical = fs.readFileSync(getNote(ctx, note.id).path, 'utf-8');
      expect(canonical.match(/<!-- zk:related -->/g)).toHaveLength(1);
      expect(canonical.match(/^## Related$/gm)).toHaveLength(1);
    }
  });

  it('derives handler update tokens from the shared helper for omitted metadata and an explicit low-confidence target', async () => {
    const relatedId = storedId(await handleStore(args({ title: 'Related for parity', content: 'related parity content', summary: 'Related parity summary.' }), ctx.engine, null, ctx.config));
    const id = storedId(await handleStore(args({ title: 'Parity target', tags: ['topic'], related: [relatedId] }), ctx.engine, null, ctx.config));
    const target = getNote(ctx, id);

    // Title and content diverge, so the target is only reachable as an explicit
    // low-confidence update target; tags and related are omitted to preserve.
    const updateArgs = args({
      title: 'Wholly different parity title',
      content: 'wholly different parity content with authored [[2026081217215097|inline link]]',
      disposition: 'update',
      noteId: id,
      expectedUpdatedAt: target.updated_at,
      dryRun: true,
    });
    const preview = parsed(await handleStore(updateArgs, ctx.engine, null, ctx.config));

    const snapshot = ctx.engine.getScreeningSnapshot({ project: 'demo' });
    const note = snapshot.notes.find(item => item.id === id);
    if (!note) throw new Error('Expected screening note');
    const candidate: ScreeningCandidate = {
      title: updateArgs.title,
      content: updateArgs.content,
      summary: updateArgs.summary ?? '',
      guidance: updateArgs.guidance ?? '',
      kind: target.kind,
      status: target.status,
      lifecycle: target.lifecycle,
      tags: [...target.tags],
      related: ctx.engine.getGeneratedRelatedIds(target.id),
    };
    const helper = reviewedOperationTokens({
      candidate,
      evaluation: evaluateScreeningCandidate(candidate, snapshot),
      snapshotVersion: snapshot.schemaVersion,
      configVersion: 'reviewed-storage-v1',
      targetId: id,
      updateCandidate: (input, match) => {
        const matched = snapshot.notes.find(item => item.id === match.id);
        return matched ? reviewedUpdateCandidate(input, matched, { tags: true, related: false }) : input;
      },
    });

    expect(helper.updateTokens.map(token => token.id)).toContain(id);
    expect(preview.updateTokens).toEqual(helper.updateTokens);
    expect(preview.createToken).toBe(helper.createToken);

    const token = helper.updateTokens.find(item => item.id === id)?.token;
    expect(await handleStore({ ...updateArgs, dryRun: false, confirm: true, token }, ctx.engine, null, ctx.config)).toContain('Updated reference');
    expect(ctx.engine.getById(id)?.tags).toContain('topic');
  });

  it('preserves unresolved inherited generated relations but rejects them when explicit', async () => {
    const unresolvedId = '2026081217215099';
    const inlineId = '2026081217215098';
    const content = `body with authored [[${inlineId}|inline link]]`;
    const stored = ctx.engine.store(content, {
      title: 'Inherited unresolved relation', kind: 'reference', status: 'fleeting', lifecycle: 'living',
      tags: ['project:demo'], summary: 'Inherited relation summary.', guidance: 'Keep inherited relation.',
      related: [unresolvedId],
    });
    const target = getNote(ctx, stored.id);
    const updateArgs = args({
      title: target.title,
      content: `updated body with authored [[${inlineId}|inline link]]`,
      summary: target.summary,
      guidance: target.guidance,
      disposition: 'update',
      noteId: target.id,
      expectedUpdatedAt: target.updated_at,
      dryRun: true,
    });
    const preview = parsed(await handleStore(updateArgs, ctx.engine, null, ctx.config));
    const token = (preview.updateTokens as Array<{ id: string; token: string }>).find(item => item.id === target.id)?.token;
    expect(await handleStore({ ...updateArgs, dryRun: false, confirm: true, token }, ctx.engine, null, ctx.config)).toContain('Updated reference');

    const updated = getNote(ctx, target.id);
    expect(ctx.engine.getGeneratedRelatedIds(updated.id)).toEqual([unresolvedId]);
    expect(updated.content).toContain(`[[${inlineId}|inline link]]`);
    expect(updated.content).not.toContain(unresolvedId);
    const canonical = fs.readFileSync(updated.path, 'utf-8');
    expect(canonical).toContain(`- [[${unresolvedId}]]`);
    expect(canonical.match(/<!-- zk:related -->/g)).toHaveLength(1);

    const rejected = await handleStore({ ...updateArgs, related: [unresolvedId], expectedUpdatedAt: updated.updated_at }, ctx.engine, null, ctx.config);
    expect(rejected).toContain(`Related note not found or not visible: ${unresolvedId}`);
  });

  it('reuses a single visibility-aligned screening snapshot for preview and refreshes it only under the lock', async () => {
    const id = storedId(await handleStore(args({ title: 'Snapshot reuse target' }), ctx.engine, null, ctx.config));
    const target = getNote(ctx, id);
    const original = ctx.engine.getScreeningSnapshot.bind(ctx.engine);
    let calls = 0;
    const spied = ctx.engine as unknown as { getScreeningSnapshot: typeof original };
    spied.getScreeningSnapshot = visibility => { calls += 1; return original(visibility); };
    const updateArgs = args({ title: 'Snapshot reuse target', content: 'snapshot reuse update', disposition: 'update', noteId: id, expectedUpdatedAt: target.updated_at, dryRun: true });
    try {
      await handleStore(args({ title: 'Snapshot reuse create', dryRun: true }), ctx.engine, null, ctx.config);
      expect(calls).toBe(1);

      calls = 0;
      const preview = parsed(await handleStore(updateArgs, ctx.engine, null, ctx.config));
      expect(calls).toBe(1);

      calls = 0;
      const token = (preview.updateTokens as Array<{ id: string; token: string }>).find(item => item.id === id)?.token;
      expect(await handleStore({ ...updateArgs, dryRun: false, confirm: true, token }, ctx.engine, null, ctx.config)).toContain('Updated reference');
      // One preflight/initial snapshot plus one locked re-evaluation snapshot.
      expect(calls).toBe(2);
    } finally {
      spied.getScreeningSnapshot = original;
    }
  });

  it('does not duplicate the Related section when reviewed update content comes from knowledge-get', async () => {
    const relatedId = storedId(await handleStore(args({ title: 'Related for round trip', content: 'round trip related content', summary: 'Round trip related summary.' }), ctx.engine, null, ctx.config));
    const id = storedId(await handleStore(args({ title: 'Round trip target', related: [relatedId] }), ctx.engine, null, ctx.config));

    const rendered = handleGet({ noteId: id, project: 'demo' }, ctx.engine);
    const fetchedContent = /<content>([\s\S]*?)<\/content>/.exec(rendered)?.[1];
    if (!fetchedContent) throw new Error(`Expected content in: ${rendered}`);
    expect(fetchedContent).not.toContain('## Related');

    // Managed relations are omitted from returned content, but omitting `related`
    // on a verbatim or extended round trip preserves them from the canonical file.
    const extended = `${fetchedContent}\n\nadded round trip line`;
    for (const content of [fetchedContent, extended]) {
      const current = getNote(ctx, id);
      const roundTripArgs = args({
        title: 'Round trip target',
        content,
        disposition: 'update',
        noteId: id,
        expectedUpdatedAt: current.updated_at,
        dryRun: true,
      });
      const roundTripPreview = parsed(await handleStore(roundTripArgs, ctx.engine, null, ctx.config));
      const roundTripToken = (roundTripPreview.updateTokens as Array<{ id: string; token: string }>).find(item => item.id === id)?.token;
      expect(await handleStore({ ...roundTripArgs, dryRun: false, confirm: true, token: roundTripToken }, ctx.engine, null, ctx.config)).toContain('Updated reference');
      expect(ctx.engine.getGeneratedRelatedIds(id)).toEqual([relatedId]);
      const canonical = fs.readFileSync(getNote(ctx, id).path, 'utf-8');
      expect(canonical.match(/<!-- zk:related -->/g)).toHaveLength(1);
      expect(canonical.match(/^## Related$/gm)).toHaveLength(1);
    }

    expect(ctx.engine.getById(id)?.content).toContain('added round trip line');
  });

  it('rejects a reviewed update when canonical bytes change immediately before the write', async () => {
    const id = storedId(await handleStore(args(), ctx.engine, null, ctx.config));
    const target = getNote(ctx, id);
    const updateArgs = args({ content: 'late reviewed replacement', disposition: 'update', noteId: id, expectedUpdatedAt: target.updated_at, dryRun: true });
    const preview = parsed(await handleStore(updateArgs, ctx.engine, null, ctx.config));
    const token = (preview.updateTokens as Array<{ id: string; token: string }>).find(item => item.id === id)?.token;

    const rejected = await ctx.engine.withKnowledgeMutationLockAsync(async context => {
      const interceptingContext = {
        getScreeningSnapshot: context.getScreeningSnapshot,
        store: ((...storeArgs: Parameters<typeof context.store>) => {
          fs.appendFileSync(target.path, '\nLate external edit\n');
          return context.store(...storeArgs);
        }) as typeof context.store,
      };
      return handleStore({ ...updateArgs, dryRun: false, confirm: true, token }, ctx.engine, null, ctx.config, undefined, interceptingContext);
    });
    expect(rejected).toContain('canonical file changed before write');
    expect(ctx.engine.getById(id)?.content).toBe('durable canonical content');
    expect(fs.readFileSync(target.path, 'utf8')).toContain('Late external edit');
  });

  it('rejects a reviewed update after an out-of-band canonical Markdown edit', async () => {
    const created = await handleStore(args(), ctx.engine, null, ctx.config);
    const id = storedId(created);
    const target = getNote(ctx, id);
    const updateArgs = args({ content: 'reviewed replacement', disposition: 'update', noteId: id, expectedUpdatedAt: target.updated_at, dryRun: true });
    const preview = parsed(await handleStore(updateArgs, ctx.engine, null, ctx.config));
    const token = (preview.updateTokens as Array<{ id: string; token: string }>).find(item => item.id === id)?.token;
    const editedBytes = `${fs.readFileSync(target.path, 'utf8')}\nOut-of-band edit\n`;
    fs.writeFileSync(target.path, editedBytes);

    const rejected = await handleStore({ ...updateArgs, dryRun: false, confirm: true, token }, ctx.engine, null, ctx.config);
    expect(rejected).toContain('token is stale');
    expect(fs.readFileSync(target.path, 'utf8')).toBe(editedBytes);
    expect(ctx.engine.getById(id)?.content).toBe('durable canonical content');
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
    try {
      const pendingStore = handleStore(args({ title: 'Queued memory' }), second, null, ctx.config)
        .finally(() => { settled = true; });
      await Bun.sleep(10);
      expect(settled).toBe(false);
      release();
      await holder;
      expect(await pendingStore).toContain('Stored reference: "Queued memory"');
    } finally {
      second.close();
    }
  });

  it('fails screening-relevant writers from another instance while an async holder owns the lock', async () => {
    const note = ctx.engine.store('lock race content', { title: 'Lock race target', kind: 'reference', status: 'fleeting', lifecycle: 'living', tags: ['project:demo'], summary: 'Lock race summary.', guidance: 'Keep it.' });
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
    try {
      const writers: Array<[string, () => unknown]> = [
        ['archive', () => second.archive(note.id)],
        ['remove', () => second.remove(note.id)],
        ['updatePath', () => second.updatePath(note.id, `${note.path}.raced`)],
        ['updateTags', () => second.updateTags(note.id, ['project:demo', 'raced'])],
        ['updateContentHash', () => second.updateContentHash(note.id, 'deadbeef')],
        ['updateSummaryGuidance', () => second.updateSummaryGuidance(note.id, 'Raced.', 'Raced.')],
        ['rebuildFromFiles', () => second.rebuildFromFiles()],
      ];
      for (const [name, writer] of writers) {
        expect(writer, name).toThrow('Knowledge mutation is already in progress');
      }
      // No writer observed the vault, so the note is untouched.
      expect(second.getById(note.id)?.status).toBe('fleeting');
      expect(second.getById(note.id)?.tags).not.toContain('raced');
    } finally {
      release();
      await holder;
      second.close();
    }
  });

  it('queues semantic metadata writes behind an async lock holder instead of discarding them', async () => {
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
    try {
      const pending = handleStore(args(), second, null, ctx.config);
      // Give the queued store time to contend for the lock before it is released.
      await new Promise(resolve => setTimeout(resolve, 20));
      release();
      await holder;
      const output = await pending;
      const id = storedId(output);
      expect(second.getAllContentHashes().map(item => item.id)).toContain(id);
    } finally {
      release();
      await holder;
      second.close();
    }
  });

  it('persists semantic metadata for normalized content while keeping submitted managed relations canonical', async () => {
    const authoredContent = 'durable canonical content';
    const relatedId = '2026081217215099';
    const submittedContent = `${authoredContent}

## Related

<!-- zk:related -->
- [[${relatedId}]]`;
    const embedding = [0.1, 0.2, 0.3];
    const output = await handleStore(
      args({ content: submittedContent, summary: '' }),
      ctx.engine,
      { provider: 'api', baseUrl: 'https://api.example.com/v1', apiKey: 'test', model: 'test-model', dimensions: 3 },
      ctx.config,
      undefined,
      undefined,
      { embeddingPromise: Promise.resolve({ embedding, model: 'test-model', tokenCount: 3 }) },
    );
    const id = storedId(output);

    expect(getNote(ctx, id).content).toBe(authoredContent);
    expect(ctx.engine.getAllContentHashes().find(item => item.id === id)?.hash).toBe(computeSimHash(authoredContent));
    expect(ctx.engine.getNotesWithoutEmbeddings(Number.MAX_SAFE_INTEGER).map(note => note.id)).not.toContain(id);
    expect(ctx.engine.searchVector(embedding, { visibility: { project: 'demo' } }).map(note => note.id)).toContain(id);
    expect(ctx.engine.getGeneratedRelatedIds(id)).toEqual([relatedId]);
    const canonical = fs.readFileSync(getNote(ctx, id).path, 'utf-8');
    expect(canonical.match(/<!-- zk:related -->/g)).toHaveLength(1);
    expect(canonical).toContain(`- [[${relatedId}]]`);
  });

  it('invalidates a reviewed update token after an archive mutation of unrelated visible evidence', async () => {
    const created = await handleStore(args(), ctx.engine, null, ctx.config);
    const id = storedId(created);
    const target = getNote(ctx, id);
    const decoy = ctx.engine.store('decoy evidence content', { title: 'Decoy evidence', kind: 'reference', status: 'fleeting', lifecycle: 'living', tags: ['project:demo'], summary: 'Decoy summary.', guidance: 'Keep decoy.' });
    const candidate = args({ content: 'reviewed content after archive', disposition: 'update', noteId: id, expectedUpdatedAt: target.updated_at, dryRun: true });
    const preview = parsed(await handleStore(candidate, ctx.engine, null, ctx.config));
    const token = (preview.updateTokens as Array<{ id: string; token: string }>).find(item => item.id === id)?.token;
    expect(token).toBeDefined();

    expect(ctx.engine.archive(decoy.id)).toBe(true);
    const stale = await handleStore({ ...candidate, dryRun: false, confirm: true, token }, ctx.engine, null, ctx.config);
    expect(stale).toContain('token is stale');
    expect(ctx.engine.getById(id)?.content).toBe('durable canonical content');
  });

  it('releases the lock and preserves rebuild recovery after an accepted filesystem failure', async () => {
    const original = await handleStore(args(), ctx.engine, null, ctx.config);
    const originalId = storedId(original);
    const originalNote = getNote(ctx, originalId);
    const candidate = args({ content: 'reviewed content that will fail to write' });
    const preview = parsed(await handleStore(candidate, ctx.engine, null, ctx.config));
    const directory = path.dirname(originalNote.path);
    const heldDirectory = `${directory}.held`;
    fs.renameSync(directory, heldDirectory);
    fs.writeFileSync(directory, 'deterministic write obstruction');
    let failed: string;
    try {
      failed = await handleStore({ ...candidate, disposition: 'create', confirm: true, token: preview.createToken as string }, ctx.engine, null, ctx.config);
    } finally {
      fs.rmSync(directory, { force: true });
      fs.renameSync(heldDirectory, directory);
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
      const errors = await Promise.all(processes.map(process => new Response(process.stderr).text()));
      const results = ['a', 'b'].map((lane, index) => {
        const resultPath = `${barrier}.${lane}.result`;
        if (fs.existsSync(resultPath)) return fs.readFileSync(resultPath, 'utf8');
        return `Error: child exited ${exitCodes[index]} without a result${errors[index] ? `: ${errors[index].trim()}` : ''}`;
      });
      for (const [index, exitCode] of exitCodes.entries()) {
        if (exitCode !== 0) expect(results[index]).toStartWith('Error:');
      }
      return results;
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
