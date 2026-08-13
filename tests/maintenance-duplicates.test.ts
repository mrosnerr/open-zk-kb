import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DUPLICATE_EVIDENCE_LIMIT, evaluateDuplicates, normalizeComparableTitle } from '../src/maintenance/duplicates.js';
import { type NoteMetadata, NoteRepository } from '../src/storage/NoteRepository.js';
import { handleMaintain } from '../src/tool-handlers.js';
import { computeSimHash } from '../src/utils/simhash.js';
import { cleanupTestHarness, createTestHarness, type TestContext } from './harness.js';

function note(index: number, overrides: Partial<NoteMetadata> = {}): NoteMetadata {
  return {
    id: String(index).padStart(16, '0'),
    path: `/note-${index}.md`,
    title: `Unique ${index}`,
    kind: 'reference',
    status: 'fleeting',
    lifecycle: 'living',
    type: 'atomic',
    tags: [],
    content: `Distinct note content control number ${index}`,
    updated_at: 1,
    created_at: 1,
    word_count: 6,
    ...overrides,
  };
}

describe('duplicate audit evaluation', () => {
  it('groups matching stored and ephemeral hashes and reports their sources', () => {
    const content = 'mixed hash source duplicate content';
    const stored = { ...note(1, { content }), content_hash: computeSimHash(content) };
    const ephemeral = note(2, { content });

    const evaluation = evaluateDuplicates([ephemeral, stored]);

    expect(evaluation.coverage.hashedAtStart).toBe(1);
    expect(evaluation.coverage.computedEphemerally).toBe(1);
    expect(evaluation.simhashGroups).toHaveLength(1);
    expect(evaluation.simhashGroups[0].notes.map(item => item.id)).toEqual([stored.id, ephemeral.id]);
    expect(evaluation.simhashGroups[0].evidence).toEqual([{ noteId: ephemeral.id, distanceFromSeed: 0 }]);
  });

  it('reports every qualifying SimHash pair, including non-transitive matches', () => {
    const a = note(1, { id: 'A', content_hash: '0000000000000000' });
    const c = note(2, { id: 'C', content_hash: '0000000000000001' });
    const b = note(3, { id: 'B', content_hash: '0000000000000003' });

    const evaluation = evaluateDuplicates([b, c, a], 1);

    expect(evaluation.simhashGroups.map(group => [group.seedId, group.notes[1].id])).toEqual([
      ['A', 'C'],
      ['B', 'C'],
    ]);
    expect(evaluation.simhashGroups.every(group => group.evidence[0].distanceFromSeed === 1)).toBe(true);
  });

  it('reports the complete pair total while retaining bounded deterministic evidence', () => {
    const count = 1_000;
    const notes = Array.from({ length: count }, (_, index) => ({
      ...note(index),
      content_hash: '0000000000000000',
    }));

    const evaluation = evaluateDuplicates([...notes].reverse());

    expect(evaluation.simhashGroupTotal).toBe((count * (count - 1)) / 2);
    expect(evaluation.simhashGroups).toHaveLength(DUPLICATE_EVIDENCE_LIMIT);
    expect(evaluation.simhashGroups.map(group => [group.seedId, group.notes[1].id])).toEqual(
      Array.from({ length: DUPLICATE_EVIDENCE_LIMIT }, (_, offset) => [notes[0].id, notes[offset + 1].id]),
    );
  });

  it('evaluates more than 500 unhashed notes completely and repeatably', () => {
    const notes = Array.from({ length: 502 }, (_, index) => note(index));
    notes[500] = note(500, { title: 'Exact control', content: 'identical near duplicate control content' });
    notes[501] = note(501, { title: 'Exact control', content: 'identical near duplicate control content' });

    const first = evaluateDuplicates(notes);
    const second = evaluateDuplicates([...notes].reverse());

    expect(first.coverage).toEqual({
      eligible: 502,
      hashedAtStart: 0,
      computedEphemerally: 502,
      evaluated: 502,
      omitted: 0,
      omissionReasons: {},
      complete: true,
    });
    expect(first.titleGroups.some(group => group.notes.map(item => item.id).join(',') === `${notes[500].id},${notes[501].id}`)).toBe(true);
    expect(first.simhashGroupTotal).toBeGreaterThan(0);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('preserves word boundaries when normalizing titles and skips titles without alphanumeric content', () => {
    expect(normalizeComparableTitle('Note Book')).toBe('note book');
    expect(normalizeComparableTitle('Notebook')).toBe('notebook');
    expect(normalizeComparableTitle('Reference: note-book.md')).toBe('note book');
    expect(normalizeComparableTitle('CAFÉ—Résumé.md')).toBe('café résumé');
    expect(normalizeComparableTitle('Cafe\u0301')).toBe(normalizeComparableTitle('Café'));
    expect(normalizeComparableTitle('क')).not.toBe(normalizeComparableTitle('का'));
    expect(normalizeComparableTitle('研究：知识图谱.md')).toBe('研究 知识图谱');
    expect(normalizeComparableTitle('  ***  ')).toBe('');

    const sharedPrefix = 'A title prefix that is exactly long enough to cross the old fifty character boundary';
    const laterAlpha = `${sharedPrefix} alpha`;
    const laterBeta = `${sharedPrefix} beta`;
    expect(normalizeComparableTitle(laterAlpha)).not.toBe(normalizeComparableTitle(laterBeta));
    expect(evaluateDuplicates([
      note(10, { title: laterAlpha }),
      note(11, { title: laterBeta }),
    ]).titleGroups).toHaveLength(0);

    const spaced = note(1, { title: 'Note Book', content: 'first distinct body about paging' });
    const joined = note(2, { title: 'Notebook', content: 'second distinct body about indexing' });
    const symbolic = note(3, { title: '***', content: 'third distinct body about symbols' });
    const symbolicToo = note(4, { title: '---', content: 'fourth distinct body about dashes' });

    const evaluation = evaluateDuplicates([spaced, joined, symbolic, symbolicToo]);

    expect(evaluation.titleGroups).toEqual([]);
  });
});

describe('duplicate audit repository adapter', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness({ telemetryEnabled: false }); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('reloads a durable baseline after another repository legitimately updates an eligible note', () => {
    const stored = ctx.engine.store('original duplicate audit source', {
      title: 'Original source', kind: 'reference', status: 'fleeting',
    });
    const second = new NoteRepository(ctx.tempDir, { telemetryEnabled: false });
    try {
      second.store('current duplicate audit source', {
        existingId: stored.id, title: 'Current source', kind: 'reference', status: 'fleeting',
      });

      const result = ctx.engine.getDuplicateAuditResult();

      expect(result.indexedSnapshotUnsafe).toBe(false);
      expect(result.omissions).toEqual({});
      expect(result.notes).toHaveLength(1);
      expect(result.notes[0]).toMatchObject({ id: stored.id, title: 'Current source', content: 'current duplicate audit source' });
    } finally {
      second.close();
    }
  });

  it('reports edited indexed canonical Markdown as incomplete without mutating evidence', async () => {
    ctx.engine.store('indexed duplicate audit source', {
      title: 'Indexed source', kind: 'reference', status: 'fleeting',
    });
    const before = ctx.engine.getDuplicateAuditSnapshot();
    const indexed = before[0];
    const editedSource = `${fs.readFileSync(indexed.path, 'utf8')}\nExternal canonical edit.\n`;
    fs.writeFileSync(indexed.path, editedSource);

    const output = await handleMaintain({ action: 'dedupe', dryRun: true }, ctx.engine, ctx.config);

    expect(output).toContain('Coverage: eligible=1 | hashed-at-start=0 | computed-ephemerally=1 | evaluated=1 | omitted=0 | status=incomplete');
    expect(output).toContain('Indexed canonical drift: detected; stale groups suppressed.');
    expect(output).toContain('Groups: exact-title=0 | SimHash=0 (incomplete totals)');
    expect(output).not.toContain('No duplicate notes found.');
    expect(output).not.toContain(indexed.path);
    expect(fs.readFileSync(indexed.path, 'utf8')).toBe(editedSource);
    expect(ctx.engine.getDuplicateAuditSnapshot()).toEqual(before);
  });

  it('reports added unindexed canonical Markdown as incomplete without mutating evidence', async () => {
    ctx.engine.store('indexed duplicate audit control', {
      title: 'Indexed control', kind: 'reference', status: 'fleeting',
    });
    const before = ctx.engine.getDuplicateAuditSnapshot();
    const unindexedPath = path.join(ctx.tempDir, 'references', '2099010101010101-unindexed.md');
    const unindexedSource = '---\nid: "2099010101010101"\ntitle: Unindexed control\nkind: reference\nstatus: fleeting\n---\n\n# Unindexed control\n';
    fs.mkdirSync(path.dirname(unindexedPath), { recursive: true });
    fs.writeFileSync(unindexedPath, unindexedSource);

    const output = await handleMaintain({ action: 'dedupe', dryRun: true }, ctx.engine, ctx.config);

    expect(output).toContain('Coverage: eligible=2 | hashed-at-start=0 | computed-ephemerally=1 | evaluated=1 | omitted=1 | status=incomplete');
    expect(output).toContain('Omission reasons: {"unindexed":1}');
    expect(output).toContain('Groups: exact-title=0 | SimHash=0 (incomplete totals)');
    expect(output).not.toContain('No duplicate notes found.');
    expect(output).not.toContain(unindexedPath);
    expect(output).not.toContain(unindexedSource);
    expect(fs.readFileSync(unindexedPath, 'utf8')).toBe(unindexedSource);
    expect(ctx.engine.getDuplicateAuditSnapshot()).toEqual(before);
  });

  it('suppresses stale groups when indexed drift and an unindexed document coexist', async () => {
    const first = ctx.engine.store('same duplicate audit body', {
      title: 'Same duplicate audit title', kind: 'reference', status: 'fleeting',
    });
    ctx.engine.store('same duplicate audit body', {
      title: 'Same duplicate audit title', kind: 'reference', status: 'fleeting',
    });
    fs.appendFileSync(first.path, '\nExternal canonical edit.\n');
    const unindexedPath = path.join(ctx.tempDir, 'references', '2099010101010102-unindexed.md');
    fs.mkdirSync(path.dirname(unindexedPath), { recursive: true });
    fs.writeFileSync(unindexedPath, '---\nid: "2099010101010102"\ntitle: Unindexed\nkind: reference\nstatus: fleeting\n---\n');

    const output = await handleMaintain({ action: 'dedupe', dryRun: true }, ctx.engine, ctx.config);

    expect(output).toContain('Coverage: eligible=3 | hashed-at-start=0 | computed-ephemerally=2 | evaluated=2 | omitted=1 | status=incomplete');
    expect(output).toContain('Omission reasons: {"unindexed":1}');
    expect(output).toContain('Indexed canonical drift: detected; stale groups suppressed.');
    expect(output).toContain('Groups: exact-title=0 | SimHash=0 (incomplete totals)');
    expect(output).not.toContain('No duplicate notes found.');
  });

  it('keeps eligible groups when only archived or structural indexed files were edited externally', async () => {
    const first = ctx.engine.store('shared duplicate audit body', {
      title: 'Shared duplicate audit title', kind: 'reference', status: 'fleeting',
    });
    const second = ctx.engine.store('shared duplicate audit body', {
      title: 'Shared duplicate audit title', kind: 'reference', status: 'fleeting',
    });
    const archived = ctx.engine.store('archived duplicate audit body', {
      title: 'Archived control', kind: 'reference', status: 'archived',
    });
    const structural = ctx.engine.store('Generated navigation.', {
      title: 'Structural control', kind: 'index', status: 'fleeting',
    });
    fs.appendFileSync(archived.path, '\nExternal canonical edit.\n');
    fs.appendFileSync(structural.path, '\nExternal canonical edit.\n');

    const output = await handleMaintain({ action: 'dedupe', dryRun: true }, ctx.engine, ctx.config);

    expect(output).toContain('Coverage: eligible=2 | hashed-at-start=0 | computed-ephemerally=2 | evaluated=2 | omitted=0 | status=complete');
    expect(output).toContain('(complete totals)');
    expect(output).not.toContain('Indexed canonical drift');
    expect(output).toContain(first.id);
    expect(output).toContain(second.id);
    expect(output).not.toContain(archived.path);
    expect(output).not.toContain(structural.path);
  });

  it('suppresses output when an archived indexed note becomes canonically active', async () => {
    ctx.engine.store('shared transition body', {
      title: 'Shared transition title', kind: 'reference', status: 'fleeting',
    });
    ctx.engine.store('shared transition body', {
      title: 'Shared transition title', kind: 'reference', status: 'fleeting',
    });
    const archived = ctx.engine.store('archived transition candidate', {
      title: 'Archived transition', kind: 'reference', status: 'archived',
    });
    const source = fs.readFileSync(archived.path, 'utf8').replace('status: archived', 'status: fleeting');
    fs.writeFileSync(archived.path, source);

    const output = await handleMaintain({ action: 'dedupe', dryRun: true }, ctx.engine, ctx.config);

    expect(output).toContain('status=incomplete');
    expect(output).toContain('Indexed canonical drift: detected; stale groups suppressed.');
    expect(output).toContain('Groups: exact-title=0 | SimHash=0 (incomplete totals)');
    expect(output).not.toContain(archived.path);
  });

  it('suppresses output when an indexed index note becomes canonically non-structural', async () => {
    ctx.engine.store('shared structural transition body', {
      title: 'Shared structural transition title', kind: 'reference', status: 'fleeting',
    });
    ctx.engine.store('shared structural transition body', {
      title: 'Shared structural transition title', kind: 'reference', status: 'fleeting',
    });
    const structural = ctx.engine.store('structural transition candidate', {
      title: 'Structural transition', kind: 'index', status: 'fleeting',
    });
    const source = fs.readFileSync(structural.path, 'utf8').replace('kind: index', 'kind: reference');
    fs.writeFileSync(structural.path, source);

    const output = await handleMaintain({ action: 'dedupe', dryRun: true }, ctx.engine, ctx.config);

    expect(output).toContain('status=incomplete');
    expect(output).toContain('Indexed canonical drift: detected; stale groups suppressed.');
    expect(output).toContain('Groups: exact-title=0 | SimHash=0 (incomplete totals)');
    expect(output).not.toContain(structural.path);
  });

  it('stays complete when unindexed canonical Markdown is archived or structural', async () => {
    ctx.engine.store('indexed duplicate audit control', {
      title: 'Indexed control', kind: 'reference', status: 'fleeting',
    });
    const archivedPath = path.join(ctx.tempDir, 'references', '2099010101010103-unindexed.md');
    const structuralPath = path.join(ctx.tempDir, 'references', '2099010101010104-unindexed.md');
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.writeFileSync(archivedPath, '---\nid: "2099010101010103"\ntitle: Unindexed archived\nkind: reference\nstatus: archived\n---\n');
    fs.writeFileSync(structuralPath, '---\nid: "2099010101010104"\ntitle: Unindexed structural\nkind: index\nstatus: fleeting\n---\n');

    const output = await handleMaintain({ action: 'dedupe', dryRun: true }, ctx.engine, ctx.config);

    expect(output).toContain('Coverage: eligible=1 | hashed-at-start=0 | computed-ephemerally=1 | evaluated=1 | omitted=0 | status=complete');
    expect(output).not.toContain('Omission reasons');
    expect(output).not.toContain(archivedPath);
    expect(output).not.toContain(structuralPath);
  });

  it('evaluates the complete repository snapshot without persisting ephemeral hashes', async () => {
    const controls = Array.from({ length: 500 }, (_, index) => {
      const digest = createHash('sha256').update(`control-${index}`).digest('hex');
      return ctx.engine.store(`Unique control ${digest.match(/.{1,8}/g)?.join(' ')}`, {
        title: `Unique ${index}`,
        kind: 'reference',
        status: 'fleeting',
      });
    });
    const firstDuplicate = ctx.engine.store('identical repository duplicate control content', {
      title: 'Repository exact control', kind: 'reference', status: 'fleeting',
    });
    const secondDuplicate = ctx.engine.store('identical repository duplicate control content', {
      title: 'Repository exact control', kind: 'reference', status: 'fleeting',
    });

    const before = ctx.engine.getDuplicateAuditSnapshot();
    expect(before).toHaveLength(502);
    expect(before.every(item => item.content_hash == null)).toBe(true);

    const output = await handleMaintain({ action: 'dedupe', dryRun: true }, ctx.engine, ctx.config);
    const after = ctx.engine.getDuplicateAuditSnapshot();
    const evaluation = evaluateDuplicates(after);

    expect(output).toContain('Coverage: eligible=502 | hashed-at-start=0 | computed-ephemerally=502 | evaluated=502 | omitted=0 | status=complete');
    expect(output).toContain('(complete totals)');
    expect(output).toContain(firstDuplicate.id);
    expect(output).toContain(secondDuplicate.id);
    expect(after.map(item => ({ id: item.id, hash: item.content_hash })))
      .toEqual(before.map(item => ({ id: item.id, hash: item.content_hash })));

    const controlIds = new Set(controls.map(item => item.id));
    expect(evaluation.titleGroups.every(group => group.notes.every(item => !controlIds.has(item.id)))).toBe(true);
    expect(evaluation.simhashGroups.every(group => group.notes.every(item => !controlIds.has(item.id)))).toBe(true);
  }, 10_000);
});
