import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { KnowledgeMutationBusyError, NoteRepository, processStartIdentity, shouldRecoverStaleLock, type KnowledgeMutationContext } from '../src/storage/NoteRepository.js';
import {
  evaluateScreeningCandidate,
  normalizeScreeningTitle,
  reviewedOperationToken,
  reviewedOperationTokens,
  serializeReviewedOperation,
  type ScreeningCandidate,
} from '../src/reviewed-storage.js';
import { cleanupTestHarness, createTestHarness, type TestContext } from './harness.js';

const candidate: ScreeningCandidate = {
  title: '  Exact   Title ', content: 'alpha beta gamma', summary: '', guidance: '',
  kind: 'observation', status: 'fleeting', lifecycle: 'living',
  tags: ['project:demo', 'client:all'], related: ['b', 'a'],
};

describe('reviewed storage screening', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('copies one visible active non-structural snapshot with complete hash coverage', () => {
    const visible = ctx.engine.store('alpha beta gamma', { title: 'Exact Title', tags: ['project:demo'] });
    ctx.engine.store('hidden words here', { title: 'Hidden', tags: ['project:other'] });
    ctx.engine.store('generated', { title: 'Index', kind: 'index', tags: ['project:demo'] });

    const snapshot = ctx.engine.getScreeningSnapshot({ project: 'demo', client: 'pi' });
    expect(snapshot.notes.map(note => note.id)).toEqual([visible.id]);
    expect(snapshot.notes[0].hashSource).toBe('ephemeral');
    const evaluation = evaluateScreeningCandidate(candidate, snapshot);
    expect(evaluation.coverage).toEqual({ notes: 1, exactTitle: 1, simHash: 1, storedHashes: 0, ephemeralHashes: 1, semanticAvailable: 0, semanticUnavailable: 1 });
    expect(evaluation.matches[0].exactTitle).toBe(true);
    expect(evaluation.matches[0].simHashDistance).toBe(0);
  });

  it('filters related targets through the same project and client visibility boundary', () => {
    const hiddenProject = ctx.engine.store('hidden project content', { title: 'Hidden Project Target', tags: ['project:other'] });
    const hiddenClient = ctx.engine.store('hidden client content', { title: 'Hidden Client Target', tags: ['project:demo', 'client:cursor'] });
    const visible = ctx.engine.store('visible source content', {
      title: 'Visible Source', tags: ['project:demo'], related: [hiddenProject.id, hiddenClient.id],
    });
    const snapshot = ctx.engine.getScreeningSnapshot({ project: 'demo', client: 'pi' });
    expect(snapshot.notes.find(note => note.id === visible.id)?.related).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain(hiddenProject.id);
    expect(JSON.stringify(snapshot)).not.toContain(hiddenClient.id);
  });

  it('leaves canonical files and note state unchanged while screening', () => {
    ctx.engine.store('unchanged content', { title: 'Unchanged', tags: ['project:demo'] });
    const beforeNotes = ctx.engine.getScreeningSnapshot({ project: 'demo' });
    const beforeFiles = fs.readdirSync(ctx.tempDir, { recursive: true }).map(String).sort();
    evaluateScreeningCandidate(candidate, beforeNotes);
    expect(ctx.engine.getScreeningSnapshot({ project: 'demo' })).toEqual(beforeNotes);
    expect(fs.readdirSync(ctx.tempDir, { recursive: true }).map(String).sort()).toEqual(beforeFiles);
  });

  it('is deterministic and canonically normalizes operation inputs', () => {
    const snapshot = { schemaVersion: 8, notes: [] };
    const evaluation = evaluateScreeningCandidate(candidate, snapshot);
    const input = { candidate, evaluation, snapshotVersion: 8, configVersion: 'simhash:3;semantic:0.92' };
    expect(normalizeScreeningTitle(candidate.title)).toBe('exact title');
    expect(reviewedOperationTokens(input)).toEqual(reviewedOperationTokens(input));
    expect(reviewedOperationToken({ ...input, operation: 'create' })).toBe(reviewedOperationToken({ ...input, operation: 'create' }));
    expect(serializeReviewedOperation({ ...input, operation: 'create' })).toContain('"related":["b","a"]');
    const reorderedTags = { ...candidate, tags: [...candidate.tags].reverse() };
    expect(reviewedOperationToken({ ...input, candidate: reorderedTags, operation: 'create' })).toBe(reviewedOperationToken({ ...input, operation: 'create' }));
  });

  it('withholds create tokens when high-confidence canonical evidence is unavailable', () => {
    const evaluation = evaluateScreeningCandidate(candidate, {
      schemaVersion: 8,
      notes: [{
        id: 'unreadable', title: 'Exact Title', normalizedTitle: 'exact title', content: 'alpha beta gamma',
        summary: '', guidance: '', kind: 'observation', status: 'fleeting', lifecycle: 'living',
        tags: ['project:demo'], related: [], updatedAt: 1, contentHash: '0000000000000000', hashSource: 'stored',
      }],
    });
    const tokens = reviewedOperationTokens({ candidate, evaluation, snapshotVersion: 8, configVersion: 'v1' });
    expect(evaluation.matches[0].highConfidence).toBe(true);
    expect(tokens.createToken).toBeUndefined();
  });

  it('binds tokens to low-confidence visible evidence as well as collision matches', () => {
    const empty = { schemaVersion: 8, notes: [] };
    const emptyEvaluation = evaluateScreeningCandidate(candidate, empty);
    const complement = (BigInt(`0x${emptyEvaluation.candidateHash}`) ^ 0xffffffffffffffffn).toString(16).padStart(16, '0');
    const withLowConfidence = {
      schemaVersion: 8,
      notes: [{
        id: 'low', title: 'Unrelated', normalizedTitle: 'unrelated', content: 'unrelated', summary: '', guidance: '',
        kind: 'observation' as const, status: 'fleeting' as const, lifecycle: 'living' as const,
        tags: ['project:demo'], related: [], updatedAt: 1, contentHash: complement, hashSource: 'stored' as const,
      }],
    };
    const lowEvaluation = evaluateScreeningCandidate(candidate, withLowConfidence);
    expect(lowEvaluation.matches[0].highConfidence).toBe(false);
    const base = { candidate, snapshotVersion: 8, configVersion: 'v1' };
    expect(reviewedOperationToken({ ...base, evaluation: emptyEvaluation, operation: 'create' }))
      .not.toBe(reviewedOperationToken({ ...base, evaluation: lowEvaluation, operation: 'create' }));
  });

  it('keeps an explicit low-confidence target first when more than 20 matches qualify', () => {
    const matches = Array.from({ length: 21 }, (_, index) => ({
      id: `high-${String(index).padStart(2, '0')}`, updatedAt: index, canonicalFileHash: `hash-${index}`, title: `High ${index}`,
      lifecycle: 'living' as const, status: 'fleeting' as const, kind: 'observation' as const,
      tags: [...candidate.tags], related: [], exactTitle: true, simHashDistance: 0, highConfidence: true,
    }));
    matches.push({
      id: 'target', updatedAt: 99, canonicalFileHash: 'target-hash', title: 'Target', lifecycle: 'living', status: 'fleeting',
      kind: 'observation', tags: [...candidate.tags], related: [], exactTitle: false,
      simHashDistance: 64, highConfidence: false,
    });
    const evaluation = {
      candidateHash: '0000000000000000', matches,
      coverage: { notes: 22, exactTitle: 22, simHash: 22, storedHashes: 22, ephemeralHashes: 0, semanticAvailable: 0, semanticUnavailable: 22 },
    };
    const tokens = reviewedOperationTokens({ candidate, evaluation, snapshotVersion: 8, configVersion: 'v1', targetId: 'target' });
    expect(tokens.updateTokens[0].id).toBe('target');
    expect(tokens.updateTokens.slice(0, 20).some(item => item.id === 'target')).toBe(true);
    expect(tokens.updateTokens.slice(1).map(item => item.id)).toEqual(matches.slice(0, 21).map(item => item.id));
  });

  it('reads a bounded Windows process-start identity without depending on Windows', () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const identity = processStartIdentity(42, {
      platform: 'win32',
      execFile: (file, commandArgs) => {
        calls.push({ file, args: commandArgs });
        return '2026-08-12T19:24:37.0000000Z\r\n';
      },
    });
    expect(identity).toBe('win32:2026-08-12T19:24:37.0000000Z');
    expect(calls[0]?.file).toBe('powershell.exe');
    expect(calls[0]?.args.join(' ')).toContain('ProcessId = 42');
  });

  it('makes conservative stale-lock recovery decisions for process identities', () => {
    expect(shouldRecoverStaleLock({ pidAlive: true, recordedIdentity: 'same', currentIdentity: 'same' })).toBe(false);
    expect(shouldRecoverStaleLock({ pidAlive: true, recordedIdentity: 'old', currentIdentity: 'new' })).toBe(true);
    expect(shouldRecoverStaleLock({ pidAlive: false, recordedIdentity: 'old' })).toBe(true);
    expect(shouldRecoverStaleLock({ pidAlive: true, recordedIdentity: 'old' })).toBe(false);
  });

  it('only compares semantic vectors produced by the same identified model', () => {
    const semanticCandidate = { ...candidate, embedding: [1, 0], embeddingModel: 'model-a' };
    const snapshot = {
      schemaVersion: 8,
      notes: [{
        id: 'one', title: 'Different', normalizedTitle: 'different', content: 'unrelated',
        summary: '', guidance: '', kind: 'observation' as const, status: 'fleeting' as const,
        lifecycle: 'living' as const, tags: ['project:demo'], related: [], updatedAt: 1,
        contentHash: '0000000000000000', hashSource: 'stored' as const,
        embedding: [1, 0], embeddingModel: 'model-b',
      }],
    };
    const evaluation = evaluateScreeningCandidate(semanticCandidate, snapshot);
    expect(evaluation.matches[0].semanticSimilarity).toBeUndefined();
    expect(evaluation.coverage.semanticAvailable).toBe(0);
    expect(evaluation.coverage.semanticUnavailable).toBe(1);
  });

  it('serializes independent repository create and update primitives without reentrant locking', () => {
    const second = new NoteRepository(ctx.tempDir);
    try {
      const created = ctx.engine.withKnowledgeMutationLock(lock => {
        expect(lock.getScreeningSnapshot({ project: 'demo' }).notes).toHaveLength(0);
        return lock.store('first content', { title: 'First', tags: ['project:demo'] });
      });
      const updated = second.withKnowledgeMutationLock(lock => lock.store('updated content', {
        existingId: created.id, title: 'First', tags: ['project:demo'], lifecycle: 'living',
      }));
      expect(updated.action).toBe('updated');
      expect(ctx.engine.getById(created.id)?.content).toBe('updated content');
    } finally { second.close(); }
  });

  it('reuses an active vault lease across repository instances', async () => {
    const second = new NoteRepository(ctx.tempDir);
    try {
      await ctx.engine.withKnowledgeMutationLockAsync(async () => {
        await second.withKnowledgeMutationLockAsync(async context => {
          expect(context.store('nested cross-instance content', { title: 'Nested cross-instance' }).action).toBe('created');
        });
      });
      expect(second.getAll(10)).toHaveLength(1);
    } finally { second.close(); }
  });

  it('fails synchronous same-process contention fast through a symlink alias without starving an async holder', async () => {
    const aliasPath = `${ctx.tempDir}-alias`;
    fs.symlinkSync(ctx.tempDir, aliasPath, 'dir');
    const second = new NoteRepository(aliasPath);
    try {
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      let acquired!: () => void;
      const entered = new Promise<void>(resolve => { acquired = resolve; });
      const holder = ctx.engine.withKnowledgeMutationLockAsync(async () => {
        acquired();
        await barrier;
      });
      await entered;
      const started = Date.now();
      let contentionError: unknown;
      try {
        second.store('blocked content', { title: 'Blocked' });
      } catch (error) {
        contentionError = error;
      }
      expect(contentionError).toBeInstanceOf(KnowledgeMutationBusyError);
      expect((contentionError as Error).message).toBe('Knowledge mutation is already in progress');
      expect((contentionError as Error).message).not.toContain(ctx.tempDir);
      expect((contentionError as Error).message).not.toContain(aliasPath);
      expect(Date.now() - started).toBeLessThan(1000);
      release();
      await holder;
      expect(second.store('later content', { title: 'Later' }).action).toBe('created');
    } finally {
      second.close();
      fs.rmSync(aliasPath, { force: true });
    }
  });

  it('treats an externally removed lock directory as a benign release', () => {
    const lockPath = path.join(ctx.tempDir, '.index', 'knowledge-mutation.lock');
    expect(() => ctx.engine.withKnowledgeMutationLock(context => {
      expect(fs.existsSync(lockPath)).toBe(true);
      fs.rmSync(lockPath, { recursive: true, force: true });
      return context;
    })).not.toThrow();
    expect(ctx.engine.store('content after benign release', { title: 'After benign release' }).action).toBe('created');
  });

  it('wraps non-ENOENT lock release failures', () => {
    const ownerPath = path.join(ctx.tempDir, '.index', 'knowledge-mutation.lock', 'owner.json');
    let releaseError: unknown;
    try {
      ctx.engine.withKnowledgeMutationLock(() => {
        fs.writeFileSync(ownerPath, '{invalid');
      });
    } catch (error) {
      releaseError = error;
    }

    expect(releaseError).toBeInstanceOf(Error);
    expect((releaseError as Error).name).toBe('KnowledgeMutationLockError');
    expect((releaseError as Error).message).toBe('Unable to release knowledge mutation lock');
  });

  it('redacts the vault path when lock infrastructure cannot be resolved', () => {
    const indexPath = path.join(ctx.tempDir, '.index');
    const movedIndexPath = path.join(ctx.tempDir, '.index-moved');
    fs.renameSync(indexPath, movedIndexPath);
    try {
      let lockError: unknown;
      try {
        ctx.engine.store('unreachable lock content', { title: 'Unreachable lock' });
      } catch (error) {
        lockError = error;
      }
      expect(lockError).toBeInstanceOf(Error);
      expect((lockError as Error).message).toBe('Unable to resolve knowledge mutation lock');
      expect((lockError as Error).message).not.toContain(ctx.tempDir);
    } finally {
      fs.renameSync(movedIndexPath, indexPath);
    }
  });

  it('rejects detached context and AsyncLocalStorage descendants after lease release', async () => {
    let detached: KnowledgeMutationContext | undefined;
    let trigger!: () => void;
    const deferred = new Promise<void>(resolve => { trigger = resolve; });
    let escapedStore!: Promise<unknown>;
    await ctx.engine.withKnowledgeMutationLockAsync(async context => {
      detached = context;
      escapedStore = deferred.then(() => ctx.engine.store('escaped descendant', { title: 'Escaped descendant' }));
    });
    expect(() => detached?.store('escaped context', { title: 'Escaped context' })).toThrow('Knowledge mutation context has been released');
    trigger();
    await expect(escapedStore).rejects.toThrow('Knowledge mutation context has been released');
    expect(ctx.engine.getScreeningSnapshot({}).notes).toHaveLength(0);
  });

  it('conservatively recovers a stale dead-owner lock', () => {
    const lockPath = path.join(ctx.tempDir, '.index', 'knowledge-mutation.lock');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ owner: 'dead', pid: 99999999, startedAt: Date.now() - 60_000 }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    expect(ctx.engine.store('after stale lock', { title: 'Recovered', tags: ['project:demo'] }).action).toBe('created');
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
