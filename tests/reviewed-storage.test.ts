import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { NoteRepository } from '../src/storage/NoteRepository.js';
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
