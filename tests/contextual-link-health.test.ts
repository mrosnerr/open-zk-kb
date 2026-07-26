import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { evaluateContextualLinkGraph } from '../src/link-health/evaluator';
import type { ContextualLinkDocument, ContextualLinkReadResult } from '../src/link-health/types';
import { handleHealth, handleMaintain } from '../src/tool-handlers';
import { cleanupTestHarness, createTestHarness, listAllNoteFiles, sleep, type TestContext } from './harness';

function document(id: string, title: string, tags: readonly string[] = []): ContextualLinkDocument {
  return { id, title, kind: 'reference', status: 'fleeting', tags };
}

function readable(documentValue: ContextualLinkDocument, source: string): ContextualLinkReadResult {
  return { document: documentValue, ok: true, source };
}

function databaseSnapshot(ctx: TestContext): Record<string, unknown[]> {
  const db = new Database(path.join(ctx.tempDir, '.index', 'knowledge.db'), { readonly: true });
  try {
    return {
      notes: db.query('SELECT * FROM notes ORDER BY id').all(),
      links: db.query('SELECT * FROM note_links ORDER BY source_id, target_id').all(),
      conformance: db.query('SELECT * FROM template_conformance ORDER BY id').all(),
      telemetry: db.query('SELECT * FROM tool_telemetry ORDER BY id').all(),
      sessions: db.query('SELECT * FROM sessions ORDER BY session_id').all(),
    };
  } finally {
    db.close();
  }
}

describe('contextual link-health evaluator', () => {
  it('uses authored links for exact totals, broken lines, and deduplicated edges', () => {
    const a = document('2026072500000001', 'Alpha');
    const b = document('2026072500000002', 'Beta');
    const source = [
      '---',
      `up: "[[${b.id}]]"`,
      '---',
      '`[[code-target]]`',
      '[[missing-target]]',
      `[[${b.id}]]`,
      `[[${b.id}]]`,
    ].join('\n');
    const result = evaluateContextualLinkGraph(
      [readable(a, source), readable(b, 'No links here.')],
      slug => slug === b.id ? b.id : null,
    );

    expect(result.totals).toEqual({
      documentsParsed: 2,
      rawCandidates: 5,
      contextualLinks: 3,
      excludedCandidates: 2,
      parseFailures: 0,
    });
    expect(result.broken).toEqual([{
      sourceId: a.id,
      sourceTitle: a.title,
      brokenTarget: 'missing-target',
      line: 5,
      offset: source.indexOf('[[missing-target]]'),
    }]);
    expect(result.unlinked).toEqual([]);
    expect(result.oneWay).toEqual([{
      sourceId: a.id,
      sourceTitle: a.title,
      targetId: b.id,
      targetTitle: b.title,
    }]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.broken[0])).toBe(true);
    expect(Object.isFrozen(result.oneWay[0])).toBe(true);
  });

  it('deeply freezes copied tags in unlinked findings', () => {
    const tags = ['topic:immutable'];
    const lone = document('2026072500000001', 'Lone', tags);
    const result = evaluateContextualLinkGraph([readable(lone, 'No links here.')], () => null);

    expect(result.unlinked).toHaveLength(1);
    expect(Object.isFrozen(result.unlinked[0].tags)).toBe(true);
    expect(result.unlinked[0].tags).not.toBe(tags);
    expect(() => (result.unlinked[0].tags as string[]).push('mutated')).toThrow();
    tags.push('source-mutated');
    expect(result.unlinked[0].tags).toEqual(['topic:immutable']);
  });

  it('suppresses unsafe graph conclusions after a read failure but keeps valid broken findings', () => {
    const failed = document('2026072500000001', 'Failed');
    const source = document('2026072500000002', 'Source');
    const result = evaluateContextualLinkGraph([
      { document: failed, ok: false, reason: '/private/path must not escape' },
      readable(source, `[[${failed.id}]]\n[[missing-target]]`),
    ], slug => slug === failed.id ? failed.id : null);

    expect(result.incompleteGraph).toBe(true);
    expect(result.totals).toEqual({
      documentsParsed: 1,
      rawCandidates: 2,
      contextualLinks: 2,
      excludedCandidates: 0,
      parseFailures: 1,
    });
    expect(result.failures).toEqual([{ id: failed.id, title: failed.title }]);
    expect(JSON.stringify(result.failures)).not.toContain('/private/path');
    expect(result.unlinked).toEqual([]);
    expect(result.oneWay).toEqual([]);
    expect(result.broken.map(item => item.brokenTarget)).toEqual(['missing-target']);
  });

  it('exempts project-local to global publication edges from reciprocal findings', () => {
    const local = document('2026072500000001', 'Local', ['project:alpha']);
    const global = document('2026072500000002', 'Global', ['scope:global']);
    const result = evaluateContextualLinkGraph(
      [readable(local, `[[${global.id}]]`), readable(global, 'No reverse link.')],
      slug => slug === global.id ? global.id : null,
    );
    expect(result.oneWay).toEqual([]);
  });
});

describe('contextual link-health maintenance adapters', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness({ telemetryEnabled: true }); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('renders observable contextual totals and excludes inline-code links from broken results', async () => {
    ctx.engine.store('`[[code-target]]`\nAuthored [[missing-target]].', {
      title: 'Source', kind: 'reference', status: 'fleeting',
    });

    const output = await handleMaintain({ action: 'broken-links' }, ctx.engine, ctx.config);
    await sleep(0);

    expect(output).toContain('## Contextual Markdown Scan');
    expect(output).toContain('Documents: 1 | Raw candidates: 3 | Contextual links: 1 | Excluded: 2 | Parse failures: 0');
    expect(output).toContain('[[missing-target]] (not found)');
    expect(output).not.toContain('[[code-target]] (not found)');

    const rows = ctx.engine.getTelemetryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool_name: 'maintain', arg_kind: 'broken-links', result_count: 2 });
    expect(ctx.engine.getTelemetryAggregates().contextualLinkScans).toEqual({ runs: 1, excludedCandidates: 2 });
  });

  it('shows scan evidence on all-clear reciprocal link health', async () => {
    const alpha = ctx.engine.store('Alpha initial', { title: 'Alpha', kind: 'reference', status: 'fleeting' });
    const beta = ctx.engine.store(`[[${alpha.id}]]`, { title: 'Beta', kind: 'reference', status: 'fleeting' });
    ctx.engine.store(`[[${beta.id}]]`, {
      existingId: alpha.id, title: 'Alpha', kind: 'reference', status: 'fleeting',
    });

    const output = await handleMaintain({ action: 'link-health' }, ctx.engine, ctx.config);
    expect(output).toContain('## Contextual Markdown Scan');
    expect(output).toContain('Link health: all clear.');
  });

  it('surfaces file-read failures and does not claim all-clear health', async () => {
    const note = ctx.engine.store('No links', { title: 'Unreadable', kind: 'reference', status: 'fleeting' });
    fs.unlinkSync(note.path);

    const output = await handleMaintain({ action: 'link-health' }, ctx.engine, ctx.config);

    expect(output).toContain('Parse failures: 1');
    expect(output).toContain(`"Unreadable" [${note.id}]`);
    expect(output).toContain('Unlinked evaluation was suppressed');
    expect(output).not.toContain('all clear');
    expect(output).not.toContain(note.path);
  });

  it('exposes contextual scan aggregates through health telemetry', async () => {
    ctx.engine.store('`[[example]]`\nAuthored text.', { title: 'Telemetry Source', kind: 'reference' });
    await handleMaintain({ action: 'unlinked' }, ctx.engine, ctx.config);
    await sleep(0);

    const output = await handleHealth({ project: 'test-project', telemetry: true }, ctx.engine, ctx.config);
    expect(output).toContain('Contextual link scans: 1 (excluded 2)');
  });

  it('bounds unlinked output to a default of 20, preserving the complete total and stating showing N of X', async () => {
    for (let i = 0; i < 25; i++) {
      ctx.engine.store(`Isolated body ${i}`, { title: `Isolated ${String(i).padStart(2, '0')}`, kind: 'reference', status: 'fleeting', tags: ['project:demo'] });
    }
    const output = await handleMaintain({ action: 'unlinked' }, ctx.engine, ctx.config);
    expect(output).toContain('## Unlinked Notes (25)');
    expect(output).toContain('Advisory: isolated notes are linking candidates');
    expect(output).toContain('showing 20 of 25');
    expect(output.match(/- "Isolated /g) ?? []).toHaveLength(20);
  });

  it('honors a positive explicit limit for unlinked display without changing the complete total', async () => {
    for (let i = 0; i < 25; i++) {
      ctx.engine.store(`Isolated body ${i}`, { title: `Isolated ${String(i).padStart(2, '0')}`, kind: 'reference', status: 'fleeting', tags: ['project:demo'] });
    }
    const output = await handleMaintain({ action: 'unlinked', limit: 5 }, ctx.engine, ctx.config);
    expect(output).toContain('## Unlinked Notes (25)');
    expect(output).toContain('showing 5 of 25');
    expect(output.match(/- "Isolated /g) ?? []).toHaveLength(5);
  });

  it('omits the showing message when every unlinked finding is displayed', async () => {
    for (let i = 0; i < 3; i++) {
      ctx.engine.store(`Isolated body ${i}`, { title: `Isolated ${i}`, kind: 'reference', status: 'fleeting', tags: ['project:demo'] });
    }
    const output = await handleMaintain({ action: 'unlinked' }, ctx.engine, ctx.config);
    expect(output).toContain('## Unlinked Notes (3)');
    expect(output).not.toContain('showing');
  });

  it('bounds broken-links output while preserving the complete count', async () => {
    for (let i = 0; i < 25; i++) {
      ctx.engine.store(`Authored [[missing-${String(i).padStart(2, '0')}]].`, { title: `Broken ${i}`, kind: 'reference', status: 'fleeting' });
    }
    const output = await handleMaintain({ action: 'broken-links' }, ctx.engine, ctx.config);
    expect(output).toContain('## Broken Wikilinks (25)');
    expect(output).toContain('(showing 20 of 25)');
    expect(output.match(/\(not found\)/g) ?? []).toHaveLength(20);

    const limited = await handleMaintain({ action: 'broken-links', limit: 5 }, ctx.engine, ctx.config);
    expect(limited).toContain('## Broken Wikilinks (25)');
    expect(limited).toContain('(showing 5 of 25)');
    expect(limited.match(/\(not found\)/g) ?? []).toHaveLength(5);
  });

  it('labels advisory categories and keeps complete summary totals in a bounded link-health report', async () => {
    for (let i = 0; i < 25; i++) {
      ctx.engine.store(`Authored [[missing-${String(i).padStart(2, '0')}]].`, { title: `Broken ${i}`, kind: 'reference', status: 'fleeting' });
    }
    const alpha = ctx.engine.store('Alpha body', { title: 'Alpha', kind: 'reference', status: 'fleeting' });
    ctx.engine.store(`[[${alpha.id}]]`, { title: 'Beta', kind: 'reference', status: 'fleeting' });

    const output = await handleMaintain({ action: 'link-health' }, ctx.engine, ctx.config);
    expect(output).toContain('### Broken Wikilinks (25)');
    expect(output).toContain('(showing 20 of 25)');
    expect(output).toContain('### One-Way Links (1)');
    expect(output).toContain('Advisory: A links to B');
    expect(output).toContain('## Summary');
    expect(output).toContain('Broken: 25 | One-way: 1');
  });

  it('does not mutate vault files, persisted links, or telemetry when telemetry is disabled', async () => {
    cleanupTestHarness(ctx);
    ctx = createTestHarness({ telemetryEnabled: false });
    const target = ctx.engine.store('Target body', { title: 'Target', kind: 'reference' });
    const source = ctx.engine.store(`[[${target.id}]]`, { title: 'Source', kind: 'reference' });
    const snapshotFiles = (): Record<string, string> => Object.fromEntries(
      listAllNoteFiles(ctx).map(relative => [relative, fs.readFileSync(`${ctx.tempDir}/${relative}`, 'utf8')]),
    );
    const beforeFiles = snapshotFiles();
    const beforeDatabase = databaseSnapshot(ctx);

    await handleMaintain({ action: 'link-health' }, ctx.engine, ctx.config);
    await sleep(0);

    expect(snapshotFiles()).toEqual(beforeFiles);
    expect(databaseSnapshot(ctx)).toEqual(beforeDatabase);
    expect(ctx.engine.getOutgoingLinks(source.id)).toHaveLength(1);
    expect(ctx.engine.getTelemetryRows()).toEqual([]);
  });
});
