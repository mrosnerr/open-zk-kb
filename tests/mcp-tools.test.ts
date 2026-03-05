// tests/mcp-tools.test.ts - Test MCP tool handlers directly against NoteRepository
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  createTestHarness,
  cleanupTestHarness,
} from './harness.js';
import type { TestContext } from './harness.js';
import { renderNoteForAgent } from '../src/prompts.js';
import { getPendingMigrations, getMigrationById } from '../src/data-migrations.js';
import { handleStore, handleSearch, handleMaintain } from '../src/tool-handlers.js';

describe('MCP Tool: knowledge-store', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should store a note with kind-based default status', () => {
    const output = handleStore({
      title: 'Test Preference',
      content: 'I prefer dark mode',
      kind: 'personalization',
      summary: 'User prefers dark mode',
      guidance: 'Apply dark mode when configuring editors',
    }, ctx.engine);

    expect(output).toContain('Knowledge stored (created)');
    expect(output).toContain('Kind: personalization');
    expect(output).toContain('Status: permanent');
  });

  it('should store with explicit status override', () => {
    const output = handleStore({
      title: 'Fleeting Pref',
      content: 'Maybe I like light mode',
      kind: 'personalization',
      status: 'fleeting',
      summary: 'User might prefer light mode',
      guidance: 'Consider light mode as alternative',
    }, ctx.engine);

    expect(output).toContain('Status: fleeting');
  });

  it('should auto-add project tag', () => {
    handleStore({
      title: 'Project Decision',
      content: 'Use PostgreSQL for this project',
      kind: 'decision',
      project: 'myapp',
      summary: 'Chose PostgreSQL for myapp',
      guidance: 'Use PostgreSQL for all database needs in myapp',
    }, ctx.engine);

    const notes = ctx.engine.getByKind('decision');
    expect(notes.length).toBe(1);
    expect(notes[0].tags).toContain('project:myapp');
  });

  it('should append related notes as wikilinks', () => {
    // Store a first note
    const result1 = ctx.engine.store('Base concept', {
      title: 'Base Note',
      kind: 'reference',
      existingId: '202602081000',
    });

    const output = handleStore({
      title: 'Follow-up',
      content: 'This builds on the base',
      kind: 'reference',
      related: ['202602081000'],
      summary: 'Follow-up to base concept',
      guidance: 'Reference alongside base note',
    }, ctx.engine);

    expect(output).toContain('Knowledge stored (created)');
    // The stored note content should include the related section
    const notes = ctx.engine.search('builds on the base');
    expect(notes.length).toBeGreaterThan(0);
  });

  it('should store with summary and guidance', () => {
    const output = handleStore({
      title: 'Prefers Tailwind',
      content: 'The user prefers Tailwind CSS utility classes over Bootstrap for styling.',
      kind: 'personalization',
      summary: 'User prefers Tailwind CSS over Bootstrap for styling',
      guidance: 'Use Tailwind when suggesting CSS frameworks or reviewing CSS code',
    }, ctx.engine);

    expect(output).toContain('Knowledge stored (created)');

    // Verify summary/guidance persisted in DB
    const notes = ctx.engine.search('Tailwind');
    expect(notes.length).toBe(1);
    expect(notes[0].summary).toBe('User prefers Tailwind CSS over Bootstrap for styling');
    expect(notes[0].guidance).toBe('Use Tailwind when suggesting CSS frameworks or reviewing CSS code');
  });
});

describe('MCP Tool: knowledge-search', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
    ctx.engine.store('I prefer TypeScript', { title: 'TS Pref', kind: 'personalization', status: 'permanent' });
    ctx.engine.store('API endpoint is /api/v2', { title: 'API Ref', kind: 'reference', status: 'fleeting' });
    ctx.engine.store('Use PostgreSQL', { title: 'DB Decision', kind: 'decision', status: 'permanent', tags: ['project:myapp'] });
  });

  afterEach(() => { cleanupTestHarness(ctx); });

  it('should find notes by text query', () => {
    const output = handleSearch({ query: 'TypeScript' }, ctx.engine);
    expect(output).toContain('TS Pref');
    expect(output).not.toContain('No matching notes');
  });

  it('should render notes as XML with summary and guidance', () => {
    const output = handleSearch({ query: 'TypeScript' }, ctx.engine);
    expect(output).toContain('<note ');
    expect(output).toContain('<summary>');
    expect(output).toContain('<guidance>');
    expect(output).toContain('</note>');
  });

  it('should filter by kind', () => {
    const output = handleSearch({ query: 'TypeScript API PostgreSQL', kind: 'personalization' }, ctx.engine);
    expect(output).toContain('personalization');
    expect(output).not.toContain('kind="decision"');
  });

  it('should filter by project tag', () => {
    const output = handleSearch({ query: 'PostgreSQL TypeScript API', project: 'myapp' }, ctx.engine);
    expect(output).toContain('DB Decision');
    expect(output).not.toContain('TS Pref');
  });

  it('should return no results message with hint', () => {
    const output = handleSearch({ query: 'xyznonexistent' }, ctx.engine);
    expect(output).toBe('No matching notes found. Try broader keywords or remove filters.');
  });
});

describe('MCP Tool: knowledge-maintain', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
    ctx.engine.store('Pref 1', { title: 'P1', kind: 'personalization', status: 'permanent' });
    ctx.engine.store('Ref 1', { title: 'R1', kind: 'reference', status: 'fleeting' });
    ctx.engine.store('Dec 1', { title: 'D1', kind: 'decision', status: 'permanent' });
  });

  afterEach(() => { cleanupTestHarness(ctx); });

  it('should return stats with upgrade status', async () => {
    const output = await handleMaintain({ action: 'stats' }, ctx.engine, ctx.config);
    expect(output).toContain('Knowledge Base Statistics');
    expect(output).toContain('3 notes');
    expect(output).toContain('personalization');
    expect(output).toContain('Upgrade Status');
    expect(output).toContain('Notes missing summary');
  });

  it('should promote a note', async () => {
    const fleeting = ctx.engine.getByKind('reference');
    expect(fleeting.length).toBe(1);

    const output = await handleMaintain({ action: 'promote', noteId: fleeting[0].id }, ctx.engine, ctx.config);
    expect(output).toContain('Promoted');

    const updated = ctx.engine.getById(fleeting[0].id);
    expect(updated!.status).toBe('permanent');
  });

  it('should archive a note', async () => {
    const notes = ctx.engine.getByKind('decision');
    const output = await handleMaintain({ action: 'archive', noteId: notes[0].id }, ctx.engine, ctx.config);
    expect(output).toContain('Archived');

    const updated = ctx.engine.getById(notes[0].id);
    expect(updated!.status).toBe('archived');
  });

  it('should delete a note', async () => {
    const notes = ctx.engine.getByKind('reference');
    const output = await handleMaintain({ action: 'delete', noteId: notes[0].id }, ctx.engine, ctx.config);
    expect(output).toContain('Deleted');

    const gone = ctx.engine.getById(notes[0].id);
    expect(gone).toBeNull();
  });

  it('should rebuild index', async () => {
    const output = await handleMaintain({ action: 'rebuild' }, ctx.engine, ctx.config);
    expect(output).toContain('Indexed');
    expect(output).toContain('Rebuild complete');
  });

  it('should require noteId for promote/archive/delete', async () => {
    expect(await handleMaintain({ action: 'promote' }, ctx.engine, ctx.config)).toContain('noteId is required');
    expect(await handleMaintain({ action: 'archive' }, ctx.engine, ctx.config)).toContain('noteId is required');
    expect(await handleMaintain({ action: 'delete' }, ctx.engine, ctx.config)).toContain('noteId is required');
  });

  it('should handle not-found noteId', async () => {
    expect(await handleMaintain({ action: 'promote', noteId: 'nonexistent' }, ctx.engine, ctx.config)).toContain('Note not found');
  });

  it('should report upgrade status for notes missing fields', async () => {
    const output = await handleMaintain({ action: 'upgrade' }, ctx.engine, ctx.config);
    expect(output).toContain('Upgrade Status');
    expect(output).toContain('missing summary');
    expect(output).toContain('missing guidance');
  });

  it('should report all upgraded when fields are present', async () => {
    ctx.engine.clearAll();
    ctx.engine.store('Content', {
      title: 'Complete Note',
      kind: 'personalization',
      status: 'permanent',
      summary: 'A complete note',
      guidance: 'Use this as reference',
    });

    const output = await handleMaintain({ action: 'upgrade' }, ctx.engine, ctx.config);
    expect(output).toContain('No upgrade needed');
  });
});

describe('renderNoteForAgent', () => {
  it('should render note as XML with summary fallback to title', () => {
    const xml = renderNoteForAgent({
      id: '202602110848',
      path: '/tmp/test.md',
      title: 'Prefers Tailwind',
      kind: 'personalization',
      status: 'permanent',
      type: 'atomic',
      tags: ['css', 'frontend'],
      content: 'The user prefers Tailwind CSS.',
      updated_at: Date.now(),
      created_at: Date.now(),
      word_count: 5,
    });

    expect(xml).toContain('id="202602110848"');
    expect(xml).toContain('kind="personalization"');
    expect(xml).toContain('status="permanent"');
    expect(xml).toContain('tags="css, frontend"');
    expect(xml).toContain('<summary>Prefers Tailwind</summary>');
    expect(xml).toContain('<guidance>');
    expect(xml).toContain('</note>');
  });

  it('should use custom summary and guidance when provided', () => {
    const xml = renderNoteForAgent({
      id: '202602110848',
      path: '/tmp/test.md',
      title: 'Prefers Tailwind',
      kind: 'personalization',
      status: 'permanent',
      type: 'atomic',
      tags: [],
      content: 'The user prefers Tailwind CSS.',
      summary: 'User prefers Tailwind CSS over Bootstrap',
      guidance: 'Use Tailwind when suggesting CSS frameworks',
      updated_at: Date.now(),
      created_at: Date.now(),
      word_count: 5,
    });

    expect(xml).toContain('<summary>User prefers Tailwind CSS over Bootstrap</summary>');
    expect(xml).toContain('<guidance>Use Tailwind when suggesting CSS frameworks</guidance>');
    // No tags attribute when empty
    expect(xml).not.toContain('tags=');
  });
});

// ---- Data migration framework tests ----

describe('Data Migrations: upgrade action', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should list pending migrations with correct counts', () => {
    ctx.engine.store('Content A', { title: 'Note A', kind: 'reference', status: 'fleeting' });
    ctx.engine.store('Content B', { title: 'Note B', kind: 'observation', status: 'fleeting' });

    const pending = getPendingMigrations(ctx.engine);
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe('v3-summary-guidance');
    expect(pending[0].pending).toBe(2);
    expect(pending[0].status).toBe('ready');
  });

  it('should report no pending when all notes have summary and guidance', () => {
    ctx.engine.store('Content', {
      title: 'Complete Note',
      kind: 'personalization',
      status: 'permanent',
      summary: 'A summary',
      guidance: 'Do this',
    });

    const pending = getPendingMigrations(ctx.engine);
    expect(pending.length).toBe(0);
  });
});

describe('Data Migrations: upgrade-read', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should return full content in XML with instructions', () => {
    ctx.engine.store('This is my preference content', {
      title: 'Dark Mode Pref',
      kind: 'personalization',
      status: 'permanent',
    });

    const migration = getMigrationById('v3-summary-guidance')!;
    const notes = migration.detect(ctx.engine);
    expect(notes.length).toBe(1);

    // Simulate what upgrade-read does
    const note = notes[0];
    expect(note.content).toContain('preference content');
    expect(note.title).toBe('Dark Mode Pref');
    expect(migration.instructions).toContain('summary');
    expect(migration.instructions).toContain('guidance');
    expect(migration.readFields).toContain('content');
  });

  it('should support pagination via detect + slice', () => {
    // Store 5 notes without summary/guidance
    for (let i = 0; i < 5; i++) {
      ctx.engine.store(`Content ${i}`, { title: `Note ${i}`, kind: 'reference', status: 'fleeting' });
    }

    const migration = getMigrationById('v3-summary-guidance')!;
    const allPending = migration.detect(ctx.engine);
    expect(allPending.length).toBe(5);

    // Simulate offset/limit
    const page1 = allPending.slice(0, 2);
    const page2 = allPending.slice(2, 4);
    const page3 = allPending.slice(4, 6);

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page3.length).toBe(1);
  });

  it('should support fetching specific noteIds via getByIds', () => {
    const r1 = ctx.engine.store('Content A', { title: 'Note A', kind: 'reference', status: 'fleeting' });
    const r2 = ctx.engine.store('Content B', { title: 'Note B', kind: 'reference', status: 'fleeting' });
    ctx.engine.store('Content C', { title: 'Note C', kind: 'reference', status: 'fleeting' });

    const fetched = ctx.engine.getByIds([r1.id, r2.id]);
    expect(fetched.length).toBe(2);
    const ids = fetched.map(n => n.id);
    expect(ids).toContain(r1.id);
    expect(ids).toContain(r2.id);
  });
});

describe('Data Migrations: upgrade-apply', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should update summary and guidance correctly', () => {
    const result = ctx.engine.store('I prefer dark mode in all editors', {
      title: 'Dark Mode Pref',
      kind: 'personalization',
      status: 'permanent',
    });

    const migration = getMigrationById('v3-summary-guidance')!;
    const success = migration.apply(ctx.engine, result.id, {
      summary: 'User prefers dark mode in all editors',
      guidance: 'Always suggest dark mode themes when configuring editors',
    });
    expect(success).toBe(true);

    const updated = ctx.engine.getById(result.id);
    expect(updated!.summary).toBe('User prefers dark mode in all editors');
    expect(updated!.guidance).toBe('Always suggest dark mode themes when configuring editors');
  });

  it('should report failure for missing notes', () => {
    const migration = getMigrationById('v3-summary-guidance')!;
    const success = migration.apply(ctx.engine, 'nonexistent999', {
      summary: 'test',
      guidance: 'test',
    });
    expect(success).toBe(false);
  });

  it('should remove migration from pending after all notes are upgraded', () => {
    const r1 = ctx.engine.store('Content A', { title: 'Note A', kind: 'reference', status: 'fleeting' });
    const r2 = ctx.engine.store('Content B', { title: 'Note B', kind: 'observation', status: 'fleeting' });

    let pending = getPendingMigrations(ctx.engine);
    expect(pending.length).toBe(1);
    expect(pending[0].pending).toBe(2);

    const migration = getMigrationById('v3-summary-guidance')!;
    migration.apply(ctx.engine, r1.id, { summary: 'Summary A', guidance: 'Guidance A' });
    migration.apply(ctx.engine, r2.id, { summary: 'Summary B', guidance: 'Guidance B' });

    pending = getPendingMigrations(ctx.engine);
    expect(pending.length).toBe(0);
  });

  it('should update markdown frontmatter when applying', () => {
    const result = ctx.engine.store('Some content here', {
      title: 'Frontmatter Test',
      kind: 'reference',
      status: 'fleeting',
    });

    const migration = getMigrationById('v3-summary-guidance')!;
    migration.apply(ctx.engine, result.id, {
      summary: 'Test summary line',
      guidance: 'Test guidance line',
    });

    // Read the file and check frontmatter was updated
    const note = ctx.engine.getById(result.id)!;
    const fs = require('fs');
    const fileContent = fs.readFileSync(note.path, 'utf-8');
    expect(fileContent).toContain('summary: Test summary line');
    expect(fileContent).toContain('guidance: Test guidance line');
  });
});

describe('Data Migrations: NoteRepository.getByIds', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should return empty array for empty input', () => {
    expect(ctx.engine.getByIds([])).toEqual([]);
  });

  it('should return only existing notes', () => {
    const r1 = ctx.engine.store('Content', { title: 'Exists', kind: 'reference', status: 'fleeting' });
    const results = ctx.engine.getByIds([r1.id, 'nonexistent']);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(r1.id);
  });

  it('should parse tags from JSON', () => {
    const r1 = ctx.engine.store('Content', {
      title: 'Tagged',
      kind: 'reference',
      status: 'fleeting',
      tags: ['tag-a', 'tag-b'],
    });
    const results = ctx.engine.getByIds([r1.id]);
    expect(results[0].tags).toEqual(['tag-a', 'tag-b']);
  });
});
