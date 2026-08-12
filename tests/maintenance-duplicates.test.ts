import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { evaluateDuplicates, normalizeComparableTitle } from '../src/maintenance/duplicates.js';
import type { NoteMetadata } from '../src/storage/NoteRepository.js';
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
    expect(first.simhashGroups.some(group => group.evidence.some(item => item.distanceFromSeed === 0))).toBe(true);
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

    expect(output).toContain('eligible=502');
    expect(output).toContain('computed-ephemerally=502');
    expect(output).toContain('evaluated=502');
    expect(output).toContain('omitted=0');
    expect(output).toContain('status=complete');
    expect(output).toContain(firstDuplicate.id);
    expect(output).toContain(secondDuplicate.id);
    expect(after.map(item => ({ id: item.id, hash: item.content_hash })))
      .toEqual(before.map(item => ({ id: item.id, hash: item.content_hash })));

    const controlIds = new Set(controls.map(item => item.id));
    expect(evaluation.titleGroups.every(group => group.notes.every(item => !controlIds.has(item.id)))).toBe(true);
    expect(evaluation.simhashGroups.every(group => group.notes.every(item => !controlIds.has(item.id)))).toBe(true);
  });
});
