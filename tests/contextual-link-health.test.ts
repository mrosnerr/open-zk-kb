import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createRepositoryContextualLinkReader } from '../src/link-health/reader';
import type { ContextualLinkDocument, ContextualLinkReadResult, ContextualLinkResolution } from '../src/link-health/types';
import { materializeGraphReview } from '../src/review/graph';
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

describe('rule-driven contextual link health', () => {
  const resolve = (knownId?: string) => (slug: string): ContextualLinkResolution =>
    slug === knownId ? { kind: 'document', id: slug } : { kind: 'unresolved' };

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
    const result = materializeGraphReview([readable(a, source), readable(b, 'No links here.')], resolve(b.id));

    expect(result.totals).toEqual({
      documentsParsed: 2,
      rawCandidates: 5,
      contextualLinks: 3,
      excludedCandidates: 2,
      parseFailures: 0,
    });
    const broken = result.review.groups.find(group => group.ruleId === 'links.broken');
    expect(broken?.findings).toHaveLength(1);
    expect(broken?.findings[0].evidence).toEqual([
      { label: 'sourceTitle', value: a.title },
      { label: 'target', value: 'missing-target' },
      { label: 'line', value: 5 },
    ]);
    expect(result.review.totals).toEqual({
      'links.broken': 1,
      'links.unlinked': 0,
      'links.reciprocal-missing': 1,
    });
    expect(result.facts.graphEdges?.edges).toHaveLength(1);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(broken?.findings[0])).toBe(true);
  });

  it('deeply freezes copied document tags', () => {
    const tags = ['topic:immutable'];
    const lone = document('2026072500000001', 'Lone', tags);
    const result = materializeGraphReview([readable(lone, 'No links here.')], resolve());
    const copiedTags = result.facts.contextualLinks?.documents[0].tags;

    expect(Object.isFrozen(copiedTags)).toBe(true);
    expect(copiedTags).not.toBe(tags);
    expect(() => (copiedTags as string[]).push('mutated')).toThrow();
    tags.push('source-mutated');
    expect(copiedTags).toEqual(['topic:immutable']);
  });

  it('suppresses unlinked findings after an unterminated-frontmatter parse failure', () => {
    const malformed = document('2026072500000001', 'Malformed');
    const isolated = document('2026072500000002', 'Isolated');
    const result = materializeGraphReview([
      readable(malformed, '---\nkey: value\nunterminated'),
      readable(isolated, 'No links here.'),
    ], resolve());

    expect(result.incompleteGraph).toBe(true);
    expect(result.totals).toEqual({
      documentsParsed: 1,
      rawCandidates: 0,
      contextualLinks: 0,
      excludedCandidates: 0,
      parseFailures: 1,
    });
    expect(result.failures).toEqual([{ id: malformed.id, title: malformed.title }]);
    expect(result.review.totals['links.unlinked']).toBe(0);
  });

  it('suppresses unsafe graph conclusions after a read failure but keeps valid broken findings', () => {
    const failed = document('2026072500000001', 'Failed');
    const source = document('2026072500000002', 'Source');
    const result = materializeGraphReview([
      { document: failed, ok: false, reason: '/private/path must not escape' },
      readable(source, `[[${failed.id}]]\n[[missing-target]]`),
    ], resolve(failed.id));

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
    expect(result.review.totals).toEqual({
      'links.broken': 1,
      'links.unlinked': 0,
      'links.reciprocal-missing': 0,
    });
  });

  it('exempts project-local to global publication edges from reciprocal findings', () => {
    const local = document('2026072500000001', 'Local', ['project:alpha']);
    const global = document('2026072500000002', 'Global', ['scope:global']);
    const result = materializeGraphReview(
      [readable(local, `[[${global.id}]]`), readable(global, 'No reverse link.')],
      resolve(global.id),
    );
    expect(result.review.totals['links.reciprocal-missing']).toBe(0);
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

  it('resolves portable links against indexed Windows path separators', () => {
    const note = ctx.engine.store('Target body', { title: 'Portable Target', kind: 'reference', status: 'fleeting' });
    const db = new Database(path.join(ctx.tempDir, '.index', 'knowledge.db'));
    try {
      db.query('UPDATE notes SET path = ? WHERE id = ?').run(note.path.replaceAll('/', '\\'), note.id);
    } finally {
      db.close();
    }

    expect(createRepositoryContextualLinkReader(ctx.engine).resolveTarget(path.basename(note.path, '.md')))
      .toEqual({ kind: 'document', id: note.id });
  });

  it('resolves case-different portable paths while treating SQL LIKE metacharacters literally', () => {
    // Insert collisions first so wildcard suffix matching deterministically selects
    // the wrong row even if SQLite returns matching rows in insertion order.
    const underscoreCollision = ctx.engine.store('Underscore collision', { title: 'Underscore Collision', kind: 'reference', status: 'fleeting' });
    const percentCollision = ctx.engine.store('Percent collision', { title: 'Percent Collision', kind: 'reference', status: 'fleeting' });
    const underscore = ctx.engine.store('Underscore body', { title: 'Underscore Target', kind: 'reference', status: 'fleeting' });
    const percent = ctx.engine.store('Percent body', { title: 'Percent Target', kind: 'reference', status: 'fleeting' });
    const db = new Database(path.join(ctx.tempDir, '.index', 'knowledge.db'));
    try {
      db.query('UPDATE notes SET path = ? WHERE id = ?').run(path.join(ctx.tempDir, 'exactXname.md'), underscoreCollision.id);
      db.query('UPDATE notes SET path = ? WHERE id = ?').run(path.join(ctx.tempDir, 'rate-anything-name.md'), percentCollision.id);
      db.query('UPDATE notes SET path = ? WHERE id = ?').run(path.join(ctx.tempDir, 'Exact_Name.md').replaceAll('/', '\\'), underscore.id);
      db.query('UPDATE notes SET path = ? WHERE id = ?').run(path.join(ctx.tempDir, 'Rate-%-Name.md').replaceAll('/', '\\'), percent.id);
    } finally {
      db.close();
    }

    expect(ctx.engine.resolveLink('exact_name')).toBe(underscore.id);
    expect(ctx.engine.resolveLink('rate-%-name')).toBe(percent.id);
    expect(ctx.engine.resolveLink('missing_name')).toBeNull();
  });

  it('detects contextual applicability identity and multiplicity drift but ignores ordering and unrelated tags', () => {
    const project = ctx.engine.store('Project body', { title: 'Project', kind: 'reference', tags: ['project:alpha'] });
    const client = ctx.engine.store('Client body', { title: 'Client', kind: 'reference', tags: ['client:pi'] });
    const global = ctx.engine.store('Global body', { title: 'Global', kind: 'reference', tags: ['scope:global'] });
    const reordered = ctx.engine.store('Reordered body', {
      title: 'Reordered', kind: 'reference', tags: ['project:alpha', 'client:pi', 'project:alpha'],
    });
    const duplicate = ctx.engine.store('Duplicate body', {
      title: 'Duplicate', kind: 'reference', tags: ['project:alpha', 'project:alpha'],
    });
    const unrelated = ctx.engine.store('Unrelated body', { title: 'Unrelated', kind: 'reference', tags: ['topic:before'] });

    fs.writeFileSync(project.path, fs.readFileSync(project.path, 'utf8').replace('project:alpha', 'project:beta'));
    fs.writeFileSync(client.path, fs.readFileSync(client.path, 'utf8').replace('client:pi', 'client:claude-code'));
    fs.writeFileSync(global.path, fs.readFileSync(global.path, 'utf8').replace('scope:global', 'topic:global'));

    const reorderedBefore = fs.readFileSync(reordered.path, 'utf8');
    const reorderedAfter = reorderedBefore.replace(
      '  - project:alpha\n  - client:pi\n  - project:alpha',
      '  - client:pi\n  - project:alpha\n  - project:alpha',
    );
    expect(reorderedAfter).not.toBe(reorderedBefore);
    fs.writeFileSync(reordered.path, reorderedAfter);

    const duplicateBefore = fs.readFileSync(duplicate.path, 'utf8');
    const duplicateAfter = duplicateBefore.replace('  - project:alpha\n  - project:alpha', '  - project:alpha');
    expect(duplicateAfter).not.toBe(duplicateBefore);
    fs.writeFileSync(duplicate.path, duplicateAfter);
    fs.writeFileSync(unrelated.path, fs.readFileSync(unrelated.path, 'utf8').replace('topic:before', 'topic:after'));

    const drift = createRepositoryContextualLinkReader(ctx.engine).listDocuments()
      .filter(result => !result.ok && result.reason === 'metadata-drift');
    const expectedDriftIds = [project, client, global, duplicate]
      .map(note => `__graph-evidence-${createHash('sha256').update(fs.realpathSync(note.path)).digest('hex')}`)
      .sort();
    expect(drift.map(result => result.document.id).sort()).toEqual(expectedDriftIds);
    expect(drift.every(result => result.document.id.startsWith('__graph-evidence-'))).toBe(true);
    expect(JSON.stringify(drift)).not.toContain(project.path);
  });

  it('fails closed when canonical status changes across active graph inclusion', () => {
    const indexedActive = ctx.engine.store('Active body', { title: 'Indexed Active', kind: 'reference', status: 'fleeting' });
    const indexedArchived = ctx.engine.store('Archived body', { title: 'Indexed Archived', kind: 'reference', status: 'archived' });
    fs.writeFileSync(indexedActive.path, fs.readFileSync(indexedActive.path, 'utf8').replace('status: fleeting', 'status: archived'));
    fs.writeFileSync(indexedArchived.path, fs.readFileSync(indexedArchived.path, 'utf8').replace('status: archived', 'status: fleeting'));

    const results = createRepositoryContextualLinkReader(ctx.engine).listDocuments();
    const drift = results.filter(result => !result.ok && result.reason === 'metadata-drift');
    expect(drift).toHaveLength(2);
    expect(drift.every(result => result.document.id.startsWith('__graph-evidence-'))).toBe(true);
    expect(JSON.stringify(drift)).not.toContain(indexedActive.path);
    expect(JSON.stringify(drift)).not.toContain(indexedArchived.path);
  });

  it('fails closed when canonical kind changes across structural graph inclusion, but ignores formatting', () => {
    const indexedDocument = ctx.engine.store('Document body', { title: 'Indexed Document', kind: 'reference', status: 'fleeting' });
    const indexedStructural = ctx.engine.store('Structural body', { title: 'Indexed Structural', kind: 'index', status: 'fleeting' });
    const formattingOnly = ctx.engine.store('Formatting body', { title: 'Formatting Only', kind: 'reference', status: 'fleeting' });
    fs.writeFileSync(indexedDocument.path, fs.readFileSync(indexedDocument.path, 'utf8').replace('kind: reference', 'kind: index'));
    fs.writeFileSync(indexedStructural.path, fs.readFileSync(indexedStructural.path, 'utf8').replace('kind: index', 'kind: reference'));
    fs.writeFileSync(formattingOnly.path, fs.readFileSync(formattingOnly.path, 'utf8').replace('kind: reference', 'kind:    reference'));

    const drift = createRepositoryContextualLinkReader(ctx.engine).listDocuments()
      .filter(result => !result.ok && result.reason === 'metadata-drift');
    expect(drift).toHaveLength(2);
  });

  it('treats an externally added canonical note file as an incomplete graph', async () => {
    const alpha = ctx.engine.store('Alpha body', { title: 'Alpha', kind: 'reference', status: 'fleeting' });
    const externalPath = path.join(ctx.tempDir, '2026072500009999-external-note.md');
    fs.writeFileSync(
      externalPath,
      `---\nid: 2026072500009999\ntitle: External Note\nkind: reference\nstatus: fleeting\n---\n\nSecret body linking [[${alpha.id}]].\n`
    );

    const output = await handleMaintain({ action: 'link-health' }, ctx.engine, ctx.config);

    expect(output).toContain('Parse failures: 1');
    expect(output).toMatch(/\[__graph-evidence-[a-f0-9]{64}(?:-\d+)?\]/);
    expect(output).not.toContain('[2026072500009999]');
    expect(output).toContain('Unlinked evaluation was suppressed');
    expect(output).not.toContain('all clear');
    expect(output).not.toContain(externalPath);
    expect(output).not.toContain('Secret body');
  });

  it('keeps graph evidence IDs distinct from duplicate external declarations and indexed IDs', () => {
    const firstPath = path.join(ctx.tempDir, 'external-a.md');
    const secondPath = path.join(ctx.tempDir, 'external-b.md');
    const collidingId = `__graph-evidence-${createHash('sha256').update(fs.realpathSync(ctx.tempDir) + path.sep + 'external-a.md').digest('hex')}`;
    ctx.engine.store('Indexed body', { existingId: collidingId, title: 'Indexed collision', kind: 'reference' });
    for (const filePath of [firstPath, secondPath]) {
      fs.writeFileSync(filePath, '---\nid: duplicate-external-id\ntitle: External\nkind: reference\n---\n');
    }

    const documents = createRepositoryContextualLinkReader(ctx.engine).listDocuments();
    const evidenceIds = documents.filter(result => !result.ok && result.reason === 'unindexed').map(result => result.document.id);
    expect(evidenceIds).toHaveLength(2);
    expect(new Set(evidenceIds).size).toBe(2);
    expect(evidenceIds).not.toContain('duplicate-external-id');
    expect(evidenceIds).not.toContain(collidingId);
    expect(evidenceIds).toContain(`${collidingId}-2`);
  });

  it('treats an unreadable vault subtree as an incomplete graph', async () => {
    ctx.engine.store('Alpha body', { title: 'Alpha', kind: 'reference', status: 'fleeting' });
    const unreadableDir = path.join(ctx.tempDir, 'unreadable-subtree');
    fs.mkdirSync(unreadableDir);
    const originalReaddirSync = fs.readdirSync;
    const readdirSync = spyOn(fs, 'readdirSync').mockImplementation((target, options) => {
      if (path.resolve(String(target)) === unreadableDir) throw new Error('mock unreadable subtree');
      return originalReaddirSync(target, options as never) as never;
    });

    try {
      const output = await handleMaintain({ action: 'link-health' }, ctx.engine, ctx.config);
      expect(output).toContain('Parse failures: 1');
      expect(output).toMatch(/\[__graph-evidence-[a-f0-9]{64}(?:-\d+)?\]/);
      expect(output).not.toContain('[vault-traversal-incomplete]');
      expect(output).toContain('Unlinked evaluation was suppressed');
      expect(output).not.toContain('all clear');
      expect(output).not.toContain(unreadableDir);
    } finally {
      readdirSync.mockRestore();
    }
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
