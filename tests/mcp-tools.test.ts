// tests/mcp-tools.test.ts - Test MCP tool handlers directly against NoteRepository
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createTestHarness,
  cleanupTestHarness,
} from './harness.js';
import type { TestContext } from './harness.js';
import { renderNoteForAgent, renderNoteForSearch, computeStaleness } from '../src/prompts.js';
import { getPendingMigrations, getMigrationById } from '../src/data-migrations.js';
import { getConfig } from '../src/config.js';
import { handleStore, handleSearch, handleMaintain, handleOverview, handleGet } from '../src/tool-handlers.js';
import { LifecycleViolationError } from '../src/storage/NoteRepository.js';
import { clearVersionCheckCache, getLatestVersion, isNewerVersion } from '../src/utils/version-check.js';

describe('MCP Tool: knowledge-store', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should store a note with kind-based default status', async () => {
    const output = await handleStore({
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

  it('should store with explicit status override', async () => {
    const output = await handleStore({
      title: 'Fleeting Pref',
      content: 'Maybe I like light mode',
      kind: 'personalization',
      status: 'fleeting',
      summary: 'User might prefer light mode',
      guidance: 'Consider light mode as alternative',
    }, ctx.engine);

    expect(output).toContain('Status: fleeting');
  });

  it('should auto-add project tag', async () => {
    await handleStore({
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

  it('should append related notes as wikilinks', async () => {
    // Store a first note
    const _result1 = ctx.engine.store('Base concept', {
      title: 'Base Note',
      kind: 'reference',
      existingId: '202602081000',
    });

    const output = await handleStore({
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

  it('should store with summary and guidance', async () => {
    const output = await handleStore({
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

  it('should warn when note exceeds kind word threshold', async () => {
    const longContent = Array(100).fill('word').join(' '); // 100 words
    const output = await handleStore({
      title: 'Oversized Personalization',
      content: longContent,
      kind: 'personalization', // warn threshold: 80
      summary: 'Test oversized note',
      guidance: 'Test guidance',
    }, ctx.engine);

    expect(output).toContain('Knowledge stored (created)');
    expect(output).toContain('⚠');
    expect(output).toContain('100 words');
    expect(output).toContain('target for personalization');
  });

  it('should warn when note exceeds absolute threshold', async () => {
    const hugeContent = Array(350).fill('word').join(' '); // 350 words
    const output = await handleStore({
      title: 'Huge Decision',
      content: hugeContent,
      kind: 'decision', // warn threshold: 250, absolute: 300
      summary: 'Test huge note',
      guidance: 'Test guidance',
    }, ctx.engine);

    expect(output).toContain('⚠');
    expect(output).toContain('350 words');
    expect(output).toContain('splitting into separate atomic notes');
  });

  it('should not warn when note is within target', async () => {
    const shortContent = 'This is a concise observation about a specific behavior.';
    const output = await handleStore({
      title: 'Good Note',
      content: shortContent,
      kind: 'observation',
      summary: 'Test concise note',
      guidance: 'Test guidance',
    }, ctx.engine);

    expect(output).toContain('Knowledge stored (created)');
    expect(output).not.toContain('⚠');
  });

  it('should not warn at exactly the warn threshold', async () => {
    // personalization warn threshold is 80 words — exactly 80 should NOT warn
    const exactContent = Array(80).fill('word').join(' ');
    const output = await handleStore({
      title: 'Boundary Personalization',
      content: exactContent,
      kind: 'personalization',
      summary: 'Test boundary',
      guidance: 'Test guidance',
    }, ctx.engine);

    expect(output).not.toContain('⚠');
  });

  it('should use kind-level message below absolute threshold', async () => {
    // 210 words for reference (warn: 200, absolute: 300) — kind-level warning
    const content = Array(210).fill('word').join(' ');
    const output = await handleStore({
      title: 'Long Reference',
      content,
      kind: 'reference',
      summary: 'Test kind-level warning',
      guidance: 'Test guidance',
    }, ctx.engine);

    expect(output).toContain('⚠');
    expect(output).toContain('Consider whether it captures more than one concept');
    expect(output).not.toContain('splitting into separate atomic notes');
  });

  it('should use absolute-level message above absolute threshold', async () => {
    // 310 words for reference — absolute-level warning
    const content = Array(310).fill('word').join(' ');
    const output = await handleStore({
      title: 'Huge Reference',
      content,
      kind: 'reference',
      summary: 'Test absolute-level warning',
      guidance: 'Test guidance',
    }, ctx.engine);

    expect(output).toContain('⚠');
    expect(output).toContain('splitting into separate atomic notes');
  });

  it('should warn for resource kind at its lower threshold', async () => {
    // resource warn threshold: 100
    const content = Array(110).fill('word').join(' ');
    const output = await handleStore({
      title: 'Long Resource',
      content,
      kind: 'resource',
      summary: 'Test resource warning',
      guidance: 'Test guidance',
    }, ctx.engine);

    expect(output).toContain('⚠');
    expect(output).toContain('target for resource: ~50');
  });
});

describe('MCP Tool: knowledge-store — related notes', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should surface FTS5-matched related notes in response', async () => {
    ctx.engine.store('React hooks provide a way to use state in functional components', {
      title: 'React Hooks Guide',
      kind: 'reference',
      status: 'permanent',
      summary: 'Guide to React hooks',
      guidance: 'Use hooks for state management',
    });

    const output = await handleStore({
      title: 'React State Management',
      content: 'React hooks are the preferred way to manage state',
      kind: 'reference',
      summary: 'State management with React hooks',
      guidance: 'Prefer hooks over class components',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Related notes:');
    expect(output).toContain('React Hooks Guide');
  });

  it('should exclude structural kinds from related notes', async () => {
    await handleStore({
      title: 'MyApp Decision',
      content: 'We chose PostgreSQL for persistence',
      kind: 'decision',
      project: 'myapp',
      summary: 'Chose PostgreSQL',
      guidance: 'Use PostgreSQL',
    }, ctx.engine, null, ctx.config);

    const indexNote = ctx.engine.getIndexNote('myapp');
    expect(indexNote).toBeTruthy();

    const output = await handleStore({
      title: 'Database Choice',
      content: 'PostgreSQL was selected for persistence layer',
      kind: 'decision',
      project: 'myapp',
      summary: 'PostgreSQL decision',
      guidance: 'Use PostgreSQL',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Related notes:');
    expect(output).toContain('MyApp Decision');
    const relatedSection = output.split('Related notes:')[1];
    expect(relatedSection).not.toContain('Index');
    expect(relatedSection).not.toContain('Operations Log');
  });

  it('should exclude domain kind from related notes', async () => {
    await handleStore({
      title: 'MyApp Domain',
      content: 'MyApp is a web application for task management',
      kind: 'domain',
      project: 'myapp',
      summary: 'MyApp domain guide',
      guidance: 'Read first',
    }, ctx.engine, null, ctx.config);

    ctx.engine.store('Task management workflows and sprint planning', {
      title: 'Task Workflows',
      kind: 'reference',
      status: 'permanent',
      summary: 'Task management workflows',
      guidance: 'Follow task workflows',
    });

    const output = await handleStore({
      title: 'Task Management Features',
      content: 'Task management application with web interface',
      kind: 'reference',
      project: 'myapp',
      summary: 'Task features',
      guidance: 'Feature reference',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Related notes:');
    expect(output).toContain('Task Workflows');
    expect(output).not.toContain('MyApp Domain');
  });

  it('should exclude archived notes from related notes', async () => {
    const storeResult = ctx.engine.store('Archived note about PostgreSQL databases', {
      title: 'Old DB Reference',
      kind: 'reference',
      status: 'permanent',
      summary: 'Old PostgreSQL reference',
      guidance: 'Outdated DB info',
    });
    ctx.engine.archive(storeResult.id);

    ctx.engine.store('Current guide to PostgreSQL databases', {
      title: 'Current DB Guide',
      kind: 'reference',
      status: 'permanent',
      summary: 'Current PostgreSQL guide',
      guidance: 'Use for DB work',
    });

    const output = await handleStore({
      title: 'PostgreSQL Best Practices',
      content: 'PostgreSQL database best practices and patterns',
      kind: 'reference',
      summary: 'PostgreSQL practices',
      guidance: 'Follow these practices',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Related notes:');
    expect(output).toContain('Current DB Guide');
    expect(output).not.toContain('Old DB Reference');
  });

  it('should not show related notes when disabled', async () => {
    ctx.engine.store('Existing note about testing', {
      title: 'Testing Guide',
      kind: 'reference',
      status: 'permanent',
      summary: 'Guide to testing',
      guidance: 'Follow testing best practices',
    });

    const disabledConfig = {
      ...ctx.config,
      store: { relatedNotes: { ...ctx.config.store.relatedNotes, enabled: false } },
    };

    const output = await handleStore({
      title: 'Testing Best Practices',
      content: 'Testing is essential for code quality',
      kind: 'reference',
      summary: 'Testing practices',
      guidance: 'Always write tests',
    }, ctx.engine, null, disabledConfig);

    expect(output).not.toContain('Related notes:');
  });

  it('should not show related notes when no matches exist', async () => {
    const output = await handleStore({
      title: 'First Note Ever',
      content: 'This is the very first note in an empty vault',
      kind: 'observation',
      summary: 'First note',
      guidance: 'Starting point',
    }, ctx.engine, null, ctx.config);

    expect(output).not.toContain('Related notes:');
  });

  it('should respect maxResults config', async () => {
    for (let i = 0; i < 8; i++) {
      ctx.engine.store(`TypeScript pattern number ${i} for advanced usage`, {
        title: `TypeScript Pattern ${i}`,
        kind: 'reference',
        status: 'permanent',
        summary: `Pattern ${i} for TypeScript`,
        guidance: `Use pattern ${i}`,
      });
    }

    const limitedConfig = {
      ...ctx.config,
      store: { relatedNotes: { ...ctx.config.store.relatedNotes, maxResults: 2 } },
    };

    const output = await handleStore({
      title: 'TypeScript Advanced Patterns',
      content: 'Advanced TypeScript patterns for type-safe development',
      kind: 'reference',
      summary: 'Advanced TS patterns',
      guidance: 'Use these patterns',
    }, ctx.engine, null, limitedConfig);

    expect(output).toContain('Related notes:');
    const relatedLines = output.split('\n').filter(l => l.startsWith('- ['));
    expect(relatedLines.length).toBeLessThanOrEqual(2);
  });

  it('should not include the stored note itself in related notes', async () => {
    ctx.engine.store('Existing reference about databases', {
      title: 'Database Reference',
      kind: 'reference',
      status: 'permanent',
      summary: 'Database info',
      guidance: 'Use for DB work',
    });

    const output = await handleStore({
      title: 'Database Patterns',
      content: 'Common database patterns and references',
      kind: 'reference',
      summary: 'DB patterns',
      guidance: 'Reference for DB patterns',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Related notes:');
    expect(output).not.toContain('"Database Patterns"');
  });

  it('should apply minSimilarity threshold and render similarity scores via vector path', () => {
    const r1 = ctx.engine.store('Very similar content about React hooks', {
      title: 'React Hooks Deep Dive',
      kind: 'reference',
      status: 'permanent',
      summary: 'Deep dive into React hooks',
      guidance: 'Use hooks',
    });
    const r2 = ctx.engine.store('Completely unrelated cooking content', {
      title: 'Pasta Recipes',
      kind: 'reference',
      status: 'permanent',
      summary: 'Italian cooking',
      guidance: 'Cook pasta',
    });
    const r3 = ctx.engine.store('Domain note for myapp', {
      title: 'MyApp Domain',
      kind: 'domain',
      status: 'permanent',
      summary: 'MyApp guide',
      guidance: 'Read first',
      tags: ['project:myapp'],
    });
    const r4 = ctx.engine.store('Archived old hooks guide', {
      title: 'Old Hooks Guide',
      kind: 'reference',
      status: 'permanent',
      summary: 'Outdated hooks',
      guidance: 'Outdated',
    });
    ctx.engine.archive(r4.id);

    ctx.engine.storeEmbedding(r1.id, [0.9, 0.1, 0.0], 'test');
    ctx.engine.storeEmbedding(r2.id, [0.0, 0.1, 0.9], 'test');
    ctx.engine.storeEmbedding(r3.id, [0.8, 0.2, 0.0], 'test');
    ctx.engine.storeEmbedding(r4.id, [0.85, 0.15, 0.0], 'test');

    const queryEmbedding = [1.0, 0.0, 0.0];
    const vecResults = ctx.engine.searchVector(queryEmbedding, { limit: 15 });

    const excludeKinds = new Set(['domain', 'index', 'log']);
    const minSimilarity = 0.70;
    const filtered = vecResults
      .filter(n => !excludeKinds.has(n.kind) && n.status !== 'archived' && n.similarity >= minSimilarity);

    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered.some(n => n.title === 'React Hooks Deep Dive')).toBe(true);
    expect(filtered.every(n => n.kind !== 'domain')).toBe(true);
    expect(filtered.every(n => n.status !== 'archived')).toBe(true);
    expect(filtered.every(n => n.title !== 'Pasta Recipes')).toBe(true);

    const topResult = filtered[0];
    expect(topResult.similarity).toBeGreaterThan(0.7);
    expect(topResult.similarity).toBeLessThanOrEqual(1.0);
    expect(typeof topResult.similarity).toBe('number');
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

describe('MCP Tool: knowledge-get', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
    ctx.engine.store('API endpoint is /api/v2', { title: 'API Ref', kind: 'reference', status: 'permanent' });
  });

  afterEach(() => { cleanupTestHarness(ctx); });

  it('should retrieve a note by exact ID', () => {
    const result = ctx.engine.store('Full API docs here', { title: 'Full API Ref', kind: 'reference', status: 'permanent' });
    const output = handleGet({ noteId: result.id }, ctx.engine);
    expect(output).toContain('Full API Ref');
    expect(output).toContain('kind="reference"');
    expect(output).toContain('<content>');
    expect(output).toContain('Full API docs here');
  });

  it('should return error for nonexistent ID', () => {
    const output = handleGet({ noteId: '9999999999999999' }, ctx.engine);
    expect(output).toBe('Note not found: 9999999999999999');
  });
});

describe('MCP Tool: knowledge-maintain', () => {
  let ctx: TestContext;
  const daysAgo = (days: number): number => Date.now() - (days * 24 * 60 * 60 * 1000);

  const setCreatedAt = (noteId: string, timestamp: number): void => {
    (ctx.engine as any).db.prepare('UPDATE notes SET created_at = ? WHERE id = ?').run(timestamp, noteId);
  };

  beforeEach(() => {
    ctx = createTestHarness({ telemetryEnabled: true });
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

  it('should backfill embeddings in bounded batches', async () => {
    ctx.engine.clearAll();
    for (let i = 0; i < 51; i++) {
      ctx.engine.store(`Batch content ${i}`, {
        title: `Batch Note ${i}`,
        kind: 'reference',
        summary: `Batch summary ${i}`,
      });
    }

    const originalFetch = globalThis.fetch;
    const batchSizes: number[] = [];
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body || '{}')) as { input?: string[] | string; model?: string };
      const inputs = Array.isArray(body.input) ? body.input : body.input ? [body.input] : [];
      batchSizes.push(inputs.length);
      return new Response(JSON.stringify({
        model: body.model || 'test-model',
        data: inputs.map((_text, index) => ({ index, embedding: [index, 0, 0] })),
      }), { status: 200 });
    };

    try {
      const output = await handleMaintain(
        { action: 'embed', limit: 51 },
        ctx.engine,
        ctx.config,
        { provider: 'api', baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', model: 'test-model', dimensions: 3 },
      );

      expect(output).toContain('Embedded 51/51');
      expect(batchSizes).toEqual([50, 1]);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it('should audit agent docs in dry-run mode without modifying files', async () => {
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agent-docs-'));

    try {
      process.env.XDG_CONFIG_HOME = tempRoot;
      const agentDocsPath = path.join(tempRoot, 'opencode', 'AGENTS.md');
      fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
      const original = 'Intro\n\n<!-- OPEN-ZK-KB:END -->\nTail\n';
      fs.writeFileSync(agentDocsPath, original, 'utf-8');

      const output = await handleMaintain({ action: 'agent-docs', dryRun: true }, ctx.engine, ctx.config);
      expect(output).toContain('Agent Docs Maintenance');
      expect(output).toContain('OpenCode');
      expect(output).toContain('malformed (end marker only)');
      expect(output).toContain('would repair markers and append a fresh managed block');
      expect(fs.readFileSync(agentDocsPath, 'utf-8')).toBe(original);
    } finally {
      if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('should conservatively repair malformed agent docs while preserving user content', async () => {
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agent-docs-'));

    try {
      process.env.XDG_CONFIG_HOME = tempRoot;
      const agentDocsPath = path.join(tempRoot, 'opencode', 'AGENTS.md');
      fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
      fs.writeFileSync(agentDocsPath, 'Intro\n\n<!-- OPEN-ZK-KB:END -->\nTail\n', 'utf-8');

      const output = await handleMaintain({ action: 'agent-docs', dryRun: false }, ctx.engine, ctx.config);
      const content = fs.readFileSync(agentDocsPath, 'utf-8');

      expect(output).toContain('OpenCode');
      expect(output).toContain('Result: updated');
      expect(content).toContain('Intro');
      expect(content).toContain('Tail');
      expect(content.match(/OPEN-ZK-KB:START -- managed by open-zk-kb/g)?.length).toBe(1);
      expect(content.match(/<!-- OPEN-ZK-KB:END -->/g)?.length).toBe(1);
    } finally {
      if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('should repair multiple-marker agent docs files by stripping duplicates and injecting fresh block', async () => {
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agent-docs-'));

    try {
      process.env.XDG_CONFIG_HOME = tempRoot;
      const agentDocsPath = path.join(tempRoot, 'opencode', 'AGENTS.md');
      fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
      const original = 'Intro\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld A\n<!-- OPEN-ZK-KB:END -->\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld B\n<!-- OPEN-ZK-KB:END -->\n';
      fs.writeFileSync(agentDocsPath, original, 'utf-8');

      const output = await handleMaintain({ action: 'agent-docs', dryRun: false }, ctx.engine, ctx.config);
      expect(output).toContain('repaired duplicate markers');
      const repaired = fs.readFileSync(agentDocsPath, 'utf-8');
      expect(repaired).toContain('Intro');
      expect(repaired).not.toContain('Old A');
      expect(repaired).not.toContain('Old B');
      expect(repaired.match(/OPEN-ZK-KB:START/g)?.length).toBe(1);
      expect(repaired.match(/OPEN-ZK-KB:END/g)?.length).toBe(1);
    } finally {
      if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
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

  it('should return review output with proper formatting and counts', async () => {
    ctx.engine.clearAll();

    const fleeting = ctx.engine.store('Old fleeting item', {
      title: 'Review Fleeting',
      kind: 'observation',
      status: 'fleeting',
    });
    const permanent = ctx.engine.store('Old permanent item', {
      title: 'Review Permanent',
      kind: 'reference',
      status: 'permanent',
    });

    setCreatedAt(fleeting.id, daysAgo(20));
    setCreatedAt(permanent.id, daysAgo(20));

    const customConfig = { ...ctx.config, lifecycle: { ...ctx.config.lifecycle, exemptKinds: [] } };
    const output = await handleMaintain({ action: 'review', limit: 10 }, ctx.engine, customConfig);

    expect(output).toContain('## Review Candidates (2 of 2)');
    expect(output).toContain('### [1]');
    expect(output).toContain('### [2]');
    expect(output).toContain('"Review Fleeting"');
    expect(output).toContain('"Review Permanent"');
    expect(output).toContain('Actions: `knowledge-maintain promote/archive/delete` with noteId=<id>');
    expect(output).not.toContain('Oversized Notes');
  });

  it('should include archive/review/promote recommendations', async () => {
    ctx.engine.clearAll();

    const promoteCandidate = ctx.engine.store('Promote candidate', {
      title: 'Promote Candidate',
      kind: 'observation',
      status: 'fleeting',
    });
    const archiveCandidate = ctx.engine.store('Archive candidate', {
      title: 'Archive Candidate',
      kind: 'observation',
      status: 'fleeting',
    });
    const reviewCandidate = ctx.engine.store('Review candidate', {
      title: 'Review Candidate',
      kind: 'observation',
      status: 'fleeting',
    });

    setCreatedAt(promoteCandidate.id, daysAgo(50));
    setCreatedAt(archiveCandidate.id, daysAgo(50));
    setCreatedAt(reviewCandidate.id, daysAgo(20));

    for (let i = 0; i < ctx.config.lifecycle.promotionThreshold; i++) {
      ctx.engine.recordAccess(promoteCandidate.id);
    }
    ctx.engine.recordAccess(reviewCandidate.id);

    const output = await handleMaintain(
      { action: 'review', filter: 'fleeting', days: 14, limit: 10 },
      ctx.engine,
      ctx.config,
    );

    expect(output).toContain('"Promote Candidate"');
    expect(output).toContain('"Archive Candidate"');
    expect(output).toContain('"Review Candidate"');
    expect(output).toContain('⮕ Suggested: PROMOTE');
    expect(output).toContain('⮕ Suggested: ARCHIVE');
    expect(output).toContain('⮕ Suggested: REVIEW');
    expect(output).toContain('## Review Candidates (3 of 3)');
  });

  it('should respect review filter in handleMaintain review action', async () => {
    ctx.engine.clearAll();

    const fleeting = ctx.engine.store('Filter fleeting', {
      title: 'Filter Fleeting',
      kind: 'observation',
      status: 'fleeting',
    });
    const permanent = ctx.engine.store('Filter permanent', {
      title: 'Filter Permanent',
      kind: 'reference',
      status: 'permanent',
    });

    setCreatedAt(fleeting.id, daysAgo(20));
    setCreatedAt(permanent.id, daysAgo(20));

    const fleetingOnly = await handleMaintain(
      { action: 'review', filter: 'fleeting', limit: 10 },
      ctx.engine,
      ctx.config,
    );
    expect(fleetingOnly).toContain('## Review Candidates (1 of 1)');
    expect(fleetingOnly).toContain('"Filter Fleeting"');
    expect(fleetingOnly).not.toContain('"Filter Permanent"');

    const permanentOnly = await handleMaintain(
      { action: 'review', filter: 'permanent', limit: 10 },
      ctx.engine,
      ctx.config,
    );
    expect(permanentOnly).toContain('## Review Candidates (1 of 1)');
    expect(permanentOnly).toContain('"Filter Permanent"');
    expect(permanentOnly).not.toContain('"Filter Fleeting"');
  });

  it('should flag oversized notes in review output', async () => {
    ctx.engine.clearAll();

    // Store a note that exceeds the personalization warn threshold (80 words)
    const longContent = Array(120).fill('word').join(' ');
    ctx.engine.store(longContent, {
      title: 'Bloated Personalization',
      kind: 'personalization',
      status: 'fleeting',
    });

    // Store a small note that should NOT appear in oversized
    ctx.engine.store('Short content', {
      title: 'Good Note',
      kind: 'observation',
      status: 'fleeting',
    });

    // Make notes old enough to appear in review (default threshold: 14 days)
    const allNotes = ctx.engine.getAll();
    for (const n of allNotes) {
      setCreatedAt(n.id, daysAgo(20));
    }

    const output = await handleMaintain(
      { action: 'review', limit: 10 },
      ctx.engine, ctx.config,
    );

    expect(output).toContain('### Oversized Notes');
    expect(output).toContain('Bloated Personalization');
    expect(output).toContain('120 words');
    // "Good Note" should appear in the review queue but NOT in the oversized section
    const oversizedSection = output.split('### Oversized Notes')[1]?.split('##')[0] || '';
    expect(oversizedSection).not.toContain('Good Note');
  });

  it('dedupe shows permanent notes as protected and never recommends archiving them', async () => {
    ctx.engine.clearAll();

    const permanent = ctx.engine.store('Canonical decision content', {
      title: 'Test Decision',
      kind: 'decision',
      status: 'permanent',
    });
    const duplicate = ctx.engine.store('Older duplicate decision content', {
      title: 'Test Decision',
      kind: 'decision',
      status: 'fleeting',
    });

    ctx.engine.recordAccess(permanent.id);
    ctx.engine.recordAccess(permanent.id);

    const result = await handleMaintain({ action: 'dedupe' }, ctx.engine, ctx.config);

    expect(result).toContain('permanent - protected');
    expect(result).toContain('⚠️ Permanent notes (🔒) are never auto-archived');
    expect(result).toContain(`Archive ${duplicate.id}`);
    expect(result).not.toContain(`Archive ${permanent.id}`);
  });

  it('dedupe backfills missing hashes and reports SimHash near-duplicates', async () => {
    ctx.engine.clearAll();

    ctx.engine.store('Use PostgreSQL for ACID transactions and reliability', {
      title: 'Database Decision A',
      kind: 'decision',
      status: 'fleeting',
    });
    ctx.engine.store('Use PostgreSQL for ACID transactions and reliability', {
      title: 'Database Decision B',
      kind: 'decision',
      status: 'fleeting',
    });

    const result = await handleMaintain({ action: 'dedupe' }, ctx.engine, ctx.config);

    expect(result).toContain('Backfilled 2 content hashes');
    expect(result).toContain('Content-Based Near-Duplicates');
    expect(result).toContain('(near-duplicate)');
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

  it('should include related_notes with wikilink targets', () => {
    const xml = renderNoteForAgent({
      id: '202602110848',
      path: '/tmp/test.md',
      title: 'Prefers Tailwind',
      kind: 'procedure',
      status: 'permanent',
      type: 'atomic',
      tags: [],
      content: 'Follow these steps. See [[2026051500000002-related-note|Related Note]] for more.',
      summary: 'User prefers Tailwind CSS over Bootstrap',
      guidance: 'Use Tailwind when suggesting CSS frameworks',
      updated_at: Date.now(),
      created_at: Date.now(),
      word_count: 5,
    });

    expect(xml).toContain('<related_notes');
    expect(xml).toContain('noteId="2026051500000002"');
    expect(xml).toContain('Related Note');
    expect(xml).toContain('Use `knowledge-get` with noteId');
  });

  it('should not include related_notes when no wikilinks exist', () => {
    const xml = renderNoteForAgent({
      id: '202602110848',
      path: '/tmp/test.md',
      title: 'Prefers Tailwind',
      kind: 'procedure',
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

    expect(xml).not.toContain('<related_notes');
  });
});

// ---- Staleness metric tests ----

describe('computeStaleness', () => {
  const baseNote = {
    id: '202602110848',
    path: '/tmp/test.md',
    title: 'Test',
    kind: 'reference' as const,
    status: 'fleeting' as const,
    type: 'atomic' as const,
    tags: [],
    content: '',
    updated_at: Date.now(),
    created_at: Date.now(),
    word_count: 0,
  };

  it('should return 0 for a note created today', () => {
    expect(computeStaleness(baseNote)).toBe(0);
  });

  it('should return correct days for older notes', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = Date.now() - (30 * DAY) - 1000;
    const note = { ...baseNote, created_at: thirtyDaysAgo };
    expect(computeStaleness(note)).toBe(30);
  });

  it('should use last_accessed_at when available', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const ninetyDaysAgo = Date.now() - (90 * DAY) - 1000;
    const fiveDaysAgo = Date.now() - (5 * DAY) - 1000;
    const note = { ...baseNote, created_at: ninetyDaysAgo, last_accessed_at: fiveDaysAgo };
    expect(computeStaleness(note)).toBe(5);
  });

  it('should fall back to created_at when last_accessed_at is undefined', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const fortyFiveDaysAgo = Date.now() - (45 * DAY) - 1000;
    const note = { ...baseNote, created_at: fortyFiveDaysAgo, last_accessed_at: undefined };
    expect(computeStaleness(note)).toBe(45);
  });

  it('should clamp to zero for future timestamps', () => {
    const tomorrow = Date.now() + (24 * 60 * 60 * 1000);
    const note = { ...baseNote, created_at: tomorrow };
    expect(computeStaleness(note)).toBe(0);
  });
});

describe('staleness_days in XML rendering', () => {
  it('should include staleness_days attribute in renderNoteForAgent', () => {
    const xml = renderNoteForAgent({
      id: '202602110848',
      path: '/tmp/test.md',
      title: 'Test',
      kind: 'reference',
      status: 'fleeting',
      type: 'atomic',
      tags: [],
      content: '',
      updated_at: Date.now(),
      created_at: Date.now(),
      word_count: 0,
    });
    expect(xml).toContain('staleness_days="0"');
  });

  it('should include staleness_days attribute in renderNoteForSearch', () => {
    const tenDaysAgo = Date.now() - (10 * 24 * 60 * 60 * 1000) - 1000;
    const xml = renderNoteForSearch({
      id: '202602110848',
      path: '/tmp/test.md',
      title: 'Test',
      kind: 'reference',
      status: 'fleeting',
      type: 'atomic',
      tags: [],
      content: 'Some content',
      updated_at: tenDaysAgo,
      created_at: tenDaysAgo,
      word_count: 2,
    });
    expect(xml).toContain('staleness_days="10"');
  });

  it('should reflect last_accessed_at in XML staleness', () => {
    const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000) - 1000;
    const twoDaysAgo = Date.now() - (2 * 24 * 60 * 60 * 1000) - 1000;
    const xml = renderNoteForAgent({
      id: '202602110848',
      path: '/tmp/test.md',
      title: 'Test',
      kind: 'reference',
      status: 'fleeting',
      type: 'atomic',
      tags: [],
      content: '',
      updated_at: ninetyDaysAgo,
      created_at: ninetyDaysAgo,
      last_accessed_at: twoDaysAgo,
      word_count: 0,
    });
    expect(xml).toContain('staleness_days="2"');
  });
});

describe('renderNoteForSearch with wikilinks', () => {
  it('should include related_notes with wikilink targets', () => {
    const xml = renderNoteForSearch({
      id: '202602110848',
      path: '/tmp/test.md',
      title: 'Parent Note',
      kind: 'reference',
      status: 'permanent',
      type: 'atomic',
      tags: [],
      content: 'See [[2026051500000002-related-note|Related Note]] and [[2026051500000003-another|Another]].',
      updated_at: Date.now(),
      created_at: Date.now(),
      word_count: 5,
    });

    expect(xml).toContain('<related_notes');
    expect(xml).toContain('noteId="2026051500000002"');
    expect(xml).toContain('noteId="2026051500000003"');
    expect(xml).toContain('Related Note');
    expect(xml).toContain('Another');
    expect(xml).toContain('Use `knowledge-get` with noteId');
  });

  it('should not include related_notes when no wikilinks exist', () => {
    const xml = renderNoteForSearch({
      id: '202602110848',
      path: '/tmp/test.md',
      title: 'Simple Note',
      kind: 'reference',
      status: 'permanent',
      type: 'atomic',
      tags: [],
      content: 'Just plain text.',
      updated_at: Date.now(),
      created_at: Date.now(),
      word_count: 2,
    });

    expect(xml).not.toContain('<related_notes');
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
    expect(fileContent).toContain('tagline: Test summary line');
    expect(fileContent).toContain('## Guidance\n\nTest guidance line');
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

// ---- Version check utility tests ----

describe('getLatestVersion', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearVersionCheckCache();
  });

  it('should return version string from npm registry', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ version: '1.2.3' }),
      { status: 200 },
    )) as any;

    const version = await getLatestVersion('open-zk-kb');
    expect(version).toBe('1.2.3');
  });

  it('should return null on non-OK response', async () => {
    globalThis.fetch = (async () => new Response('Not Found', { status: 404 })) as any;

    const version = await getLatestVersion('nonexistent-package-xyz');
    expect(version).toBeNull();
  });

  it('should return null on network error', async () => {
    globalThis.fetch = (async () => { throw new Error('Network error'); }) as any;

    const version = await getLatestVersion('open-zk-kb');
    expect(version).toBeNull();
  });

  it('should return null when response has no version field', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ name: 'open-zk-kb' }),
      { status: 200 },
    )) as any;

    const version = await getLatestVersion('open-zk-kb');
    expect(version).toBeNull();
  });

  it('should encode scoped package names', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 });
    }) as any;

    await getLatestVersion('@scope/open-zk-kb');
    expect(requestedUrl).toContain('%40scope%2Fopen-zk-kb');
  });

  it('should cache repeated version checks', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 });
    }) as any;

    expect(await getLatestVersion('open-zk-kb')).toBe('1.2.3');
    expect(await getLatestVersion('open-zk-kb')).toBe('1.2.3');
    expect(calls).toBe(1);
  });

  it('should cache non-OK responses', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('Not Found', { status: 404 });
    }) as any;

    expect(await getLatestVersion('missing-package')).toBeNull();
    expect(await getLatestVersion('missing-package')).toBeNull();
    expect(calls).toBe(1);
  });
});

// ---- Semver comparison tests ----

describe('isNewerVersion', () => {
  it('should detect newer major version', () => {
    expect(isNewerVersion('0.1.0', '1.0.0')).toBe(true);
  });

  it('should detect newer minor version', () => {
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(true);
  });

  it('should detect newer patch version', () => {
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(true);
  });

  it('should return false for same version', () => {
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
  });

  it('should return false when running newer version', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(false);
  });

  it('should detect stable as newer than pre-release of same version', () => {
    expect(isNewerVersion('0.1.0-beta.6', '0.1.0')).toBe(true);
  });

  it('should not flag pre-release as newer than stable of same version', () => {
    expect(isNewerVersion('0.1.0', '0.1.0-beta.6')).toBe(false);
  });

  it('should not flag older pre-release as newer', () => {
    expect(isNewerVersion('0.1.0-beta.6', '0.1.0-beta.5')).toBe(false);
  });

  it('should detect newer pre-release', () => {
    expect(isNewerVersion('0.1.0-beta.5', '0.1.0-beta.6')).toBe(true);
  });

  it('should detect newer multi-digit pre-release', () => {
    expect(isNewerVersion('0.1.0-beta.9', '0.1.0-beta.10')).toBe(true);
  });

  it('should not flag older multi-digit pre-release as newer', () => {
    expect(isNewerVersion('0.1.0-beta.10', '0.1.0-beta.9')).toBe(false);
  });
});

// ---- Version check in stats output ----

describe('MCP Tool: knowledge-maintain stats version check', () => {
  let ctx: TestContext;
  const originalFetch = globalThis.fetch;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => {
    cleanupTestHarness(ctx);
    globalThis.fetch = originalFetch;
    clearVersionCheckCache();
  });

  it('should show update notice when a newer version exists', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ version: '9.9.9' }),
      { status: 200 },
    )) as any;

    const output = await handleMaintain(
      { action: 'stats' }, ctx.engine, ctx.config, null, '0.1.0',
    );
    expect(output).toContain('## Version');
    expect(output).toContain('Server: 0.1.0');
    expect(output).toContain('9.9.9 available');
    expect(output).toContain('bunx open-zk-kb@latest install');
  });

  it('should not show update notice when versions match', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ version: '0.1.0' }),
      { status: 200 },
    )) as any;

    const output = await handleMaintain(
      { action: 'stats' }, ctx.engine, ctx.config, null, '0.1.0',
    );
    expect(output).not.toContain('Update Available');
  });

  it('should not show update notice when registry check fails', async () => {
    globalThis.fetch = (async () => { throw new Error('offline'); }) as any;

    const output = await handleMaintain(
      { action: 'stats' }, ctx.engine, ctx.config, null, '0.1.0',
    );
    expect(output).not.toContain('Update Available');
  });

  it('should not show update notice when running newer version than registry', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ version: '0.1.0-beta.5' }),
      { status: 200 },
    )) as any;

    const output = await handleMaintain(
      { action: 'stats' }, ctx.engine, ctx.config, null, '0.2.0',
    );
    expect(output).not.toContain('Update Available');
  });

  it('should not show update notice when currentVersion is not provided', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ version: '9.9.9' }),
      { status: 200 },
    )) as any;

    const output = await handleMaintain(
      { action: 'stats' }, ctx.engine, ctx.config,
    );
    expect(output).not.toContain('Update Available');
  });
});

// ---- Client-aware knowledge filtering (issue #30) ----

describe('MCP Tool: knowledge-store (client filtering)', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should add client tag when client param provided', async () => {
    await handleStore({
      title: 'Claude Code Workflow',
      content: 'Use skills directory for prompts',
      kind: 'procedure',
      client: 'claude-code',
      summary: 'Claude Code skill setup',
      guidance: 'Set up skills directory',
    }, ctx.engine);

    const notes = ctx.engine.getByKind('procedure');
    expect(notes.length).toBe(1);
    expect(notes[0].tags).toContain('client:claude-code');
  });

  it('should auto-detect client from .opencode/ in content', async () => {
    await handleStore({
      title: 'OpenCode Config',
      content: 'Edit .opencode/config.json to change settings',
      kind: 'reference',
      summary: 'OpenCode config location',
      guidance: 'Edit config for settings',
    }, ctx.engine);

    const notes = ctx.engine.getByKind('reference');
    expect(notes[0].tags).toContain('client:opencode');
  });

  it('should auto-detect client from .claude/ in guidance', async () => {
    await handleStore({
      title: 'Claude Instructions',
      content: 'Project instructions go in the root',
      kind: 'reference',
      summary: 'Where to put project instructions',
      guidance: 'Add instructions to .claude/settings.json in project root',
    }, ctx.engine);

    const notes = ctx.engine.getByKind('reference');
    expect(notes[0].tags).toContain('client:claude-code');
  });

  it('should NOT auto-tag universal content', async () => {
    await handleStore({
      title: 'General Preference',
      content: 'User prefers TypeScript',
      kind: 'personalization',
      summary: 'Prefers TypeScript',
      guidance: 'Use TypeScript by default',
    }, ctx.engine);

    const notes = ctx.engine.getByKind('personalization');
    const clientTags = notes[0].tags.filter((t: string) => t.startsWith('client:'));
    expect(clientTags).toHaveLength(0);
  });

  it('should warn on unrecognized client name', async () => {
    const output = await handleStore({
      title: 'Unknown Client Note',
      content: 'Some content',
      kind: 'reference',
      client: 'vscode',
      summary: 'Test note',
      guidance: 'Test guidance',
    }, ctx.engine);

    expect(output).toContain('⚠ Unrecognized client "vscode"');
    expect(output).toContain('Known clients:');
  });

  it('should NOT warn on recognized client name', async () => {
    const output = await handleStore({
      title: 'Known Client Note',
      content: 'Some content',
      kind: 'reference',
      client: 'claude-code',
      summary: 'Test note',
      guidance: 'Test guidance',
    }, ctx.engine);

    expect(output).not.toContain('Unrecognized client');
  });

  it('should use explicit client over auto-detection', async () => {
    await handleStore({
      title: 'Cross-Client Note',
      content: 'Edit .opencode/config for opencode',
      kind: 'reference',
      client: 'claude-code',
      summary: 'OpenCode config via Claude Code',
      guidance: 'Reference for Claude Code users',
    }, ctx.engine);

    const notes = ctx.engine.getByKind('reference');
    expect(notes[0].tags).toContain('client:claude-code');
    expect(notes[0].tags).not.toContain('client:opencode');
  });

  it('should not auto-tag when multiple clients detected (ambiguous)', async () => {
    await handleStore({
      title: 'Client Comparison',
      content: 'Compare .opencode/config.json vs .claude/settings.json',
      kind: 'reference',
      summary: 'Comparing client configs',
      guidance: 'Use this for cross-client reference',
    }, ctx.engine);

    const notes = ctx.engine.getByKind('reference');
    const clientTags = notes[0].tags.filter((t: string) => t.startsWith('client:'));
    expect(clientTags).toHaveLength(0);
  });

  it('should coexist client and project tags', async () => {
    await handleStore({
      title: 'Project-Client Note',
      content: 'Edit .cursor/rules for project config',
      kind: 'reference',
      project: 'myapp',
      summary: 'Cursor rules for myapp',
      guidance: 'Edit cursor rules',
    }, ctx.engine);

    const notes = ctx.engine.getByKind('reference');
    expect(notes[0].tags).toContain('project:myapp');
    expect(notes[0].tags).toContain('client:cursor');
  });
});

describe('MCP Tool: knowledge-search (client filtering)', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
    // Store notes with different client scopes
    ctx.engine.store('Universal knowledge about TypeScript', {
      title: 'Universal Note',
      kind: 'reference',
      tags: [],
    });
    ctx.engine.store('Claude-specific knowledge about skills', {
      title: 'Claude Only',
      kind: 'reference',
      tags: ['client:claude-code'],
    });
    ctx.engine.store('OpenCode-specific knowledge about agents', {
      title: 'OpenCode Only',
      kind: 'reference',
      tags: ['client:opencode'],
    });
    ctx.engine.store('Explicitly universal knowledge for all clients', {
      title: 'All Clients',
      kind: 'reference',
      tags: ['client:all'],
    });
  });

  afterEach(() => { cleanupTestHarness(ctx); });

  it('should return all notes when no client param (backward compat)', () => {
    const output = handleSearch({ query: 'knowledge' }, ctx.engine);
    expect(output).toContain('Universal Note');
    expect(output).toContain('Claude Only');
    expect(output).toContain('OpenCode Only');
    expect(output).toContain('All Clients');
  });

  it('should exclude other-client notes when client param set', () => {
    const output = handleSearch({ query: 'knowledge', client: 'claude-code' }, ctx.engine);
    expect(output).toContain('Universal Note');
    expect(output).toContain('Claude Only');
    expect(output).toContain('All Clients');
    expect(output).not.toContain('OpenCode Only');
  });

  it('should show only universal notes to a client with no scoped notes', () => {
    const output = handleSearch({ query: 'knowledge', client: 'cursor' }, ctx.engine);
    expect(output).toContain('Universal Note');
    expect(output).toContain('All Clients');
    expect(output).not.toContain('Claude Only');
    expect(output).not.toContain('OpenCode Only');
  });

  it('should combine client and project filters', () => {
    ctx.engine.store('Project-scoped Claude knowledge', {
      title: 'Claude Project Note',
      kind: 'reference',
      tags: ['client:claude-code', 'project:myapp'],
    });
    ctx.engine.store('Project-scoped OpenCode knowledge', {
      title: 'OpenCode Project Note',
      kind: 'reference',
      tags: ['client:opencode', 'project:myapp'],
    });

    const output = handleSearch({ query: 'knowledge', client: 'claude-code', project: 'myapp' }, ctx.engine);
    expect(output).toContain('Claude Project Note');
    expect(output).not.toContain('OpenCode Project Note');
    // Universal notes without project tag are excluded by project filter
    expect(output).not.toContain('Universal Note');
  });

  it('should warn on unrecognized client name in search', () => {
    const output = handleSearch({ query: 'knowledge', client: 'vscode' }, ctx.engine);
    expect(output).toContain('⚠ Unrecognized client "vscode"');
  });

  it('should NOT warn on recognized client name in search', () => {
    const output = handleSearch({ query: 'knowledge', client: 'opencode' }, ctx.engine);
    expect(output).not.toContain('Unrecognized client');
  });
});

describe('MCP Tool: knowledge-maintain scope-audit', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should detect mis-scoped notes in dry run', async () => {
    ctx.engine.store('Edit .opencode/config.json for settings', {
      title: 'Mis-scoped Note',
      kind: 'reference',
      tags: [],
      guidance: 'Configure opencode settings',
    });

    const output = await handleMaintain(
      { action: 'scope-audit', dryRun: true }, ctx.engine, ctx.config,
    );
    expect(output).toContain('Mis-scoped Notes');
    expect(output).toContain('Mis-scoped Note');
    expect(output).toContain('client:opencode');
    expect(output).toContain('Dry run');
  });

  it('should fix mis-scoped notes when dryRun is false', async () => {
    const result = ctx.engine.store('Edit .opencode/config.json for settings', {
      title: 'Fixable Note',
      kind: 'reference',
      tags: [],
      guidance: 'Configure settings',
    });

    await handleMaintain(
      { action: 'scope-audit', dryRun: false }, ctx.engine, ctx.config,
    );

    const note = ctx.engine.getById(result.id);
    expect(note!.tags).toContain('client:opencode');
  });

  it('should report no issues for correctly scoped notes', async () => {
    ctx.engine.store('Universal knowledge about TypeScript', {
      title: 'Universal Note',
      kind: 'reference',
      tags: [],
    });

    const output = await handleMaintain(
      { action: 'scope-audit', dryRun: true }, ctx.engine, ctx.config,
    );
    expect(output).toContain('No mis-scoped notes');
  });

  it('should not touch notes already correctly tagged', async () => {
    const _result = ctx.engine.store('Edit .opencode/config.json for settings', {
      title: 'Already Tagged',
      kind: 'reference',
      tags: ['client:opencode'],
      guidance: 'Configure settings',
    });

    const output = await handleMaintain(
      { action: 'scope-audit', dryRun: true }, ctx.engine, ctx.config,
    );
    expect(output).toContain('No mis-scoped notes');
  });

  it('should not auto-tag ambiguous multi-client content', async () => {
    ctx.engine.store('Compare .opencode/config.json vs .claude/settings.json', {
      title: 'Multi-Client Note',
      kind: 'reference',
      tags: [],
      guidance: 'Cross-client comparison',
    });

    const output = await handleMaintain(
      { action: 'scope-audit', dryRun: true }, ctx.engine, ctx.config,
    );
    expect(output).toContain('No mis-scoped notes');
  });

  it('should show per-client counts', async () => {
    ctx.engine.store('Claude knowledge', {
      title: 'Claude Note',
      kind: 'reference',
      tags: ['client:claude-code'],
    });
    ctx.engine.store('OpenCode knowledge', {
      title: 'OpenCode Note',
      kind: 'reference',
      tags: ['client:opencode'],
    });

    const output = await handleMaintain(
      { action: 'scope-audit', dryRun: true }, ctx.engine, ctx.config,
    );
    expect(output).toContain('client:claude-code: 1');
    expect(output).toContain('client:opencode: 1');
  });

  it('should flag notes with unrecognized client tags', async () => {
    ctx.engine.store('Unknown client knowledge', {
      title: 'Unknown Client Note',
      kind: 'reference',
      tags: ['client:vscode'],
    });

    const output = await handleMaintain(
      { action: 'scope-audit', dryRun: true }, ctx.engine, ctx.config,
    );
    expect(output).toContain('Unrecognized Client Tags');
    expect(output).toContain('Unknown Client Note');
    expect(output).toContain('client:vscode');
  });

  it('should mark unrecognized clients in per-client counts', async () => {
    ctx.engine.store('Unknown client knowledge', {
      title: 'Unknown Client Note',
      kind: 'reference',
      tags: ['client:vscode'],
    });
    ctx.engine.store('Known client knowledge', {
      title: 'Known Client Note',
      kind: 'reference',
      tags: ['client:opencode'],
    });

    const output = await handleMaintain(
      { action: 'scope-audit', dryRun: true }, ctx.engine, ctx.config,
    );
     expect(output).toContain('client:vscode: 1 ⚠ unrecognized');
    expect(output).not.toContain('client:opencode: 1 ⚠');
  });
});

describe('MCP Tool: knowledge-store (model capability)', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should append model hint when model param is absent', async () => {
    const output = await handleStore({
      title: 'No Model',
      content: 'Test content',
      kind: 'observation',
      summary: 'Test',
      guidance: 'Test',
    }, ctx.engine);

    expect(output).toContain('💡');
    expect(output).toContain('model');
  });

  it('should not append model hint when model param is provided', async () => {
    const output = await handleStore({
      title: 'With Model',
      content: 'Test content',
      kind: 'observation',
      summary: 'Test',
      guidance: 'Test',
      model: 'claude-sonnet-4',
    }, ctx.engine);

    expect(output).not.toContain('💡');
  });

  it('should show capability tier for high-tier models', async () => {
    const output = await handleStore({
      title: 'High Tier',
      content: 'Test content',
      kind: 'observation',
      summary: 'Test',
      guidance: 'Test',
      model: 'claude-opus-4',
    }, ctx.engine);

    expect(output).toContain('Capability: high');
  });

  it('should not show capability tier for medium-tier models', async () => {
    const output = await handleStore({
      title: 'Medium Tier',
      content: 'Test content',
      kind: 'observation',
      summary: 'Test',
      guidance: 'Test',
      model: 'claude-sonnet-4',
    }, ctx.engine);

    expect(output).not.toContain('Capability:');
  });

  it('should not show capability tier for low-tier models', async () => {
    const output = await handleStore({
      title: 'Low Tier',
      content: 'Test content',
      kind: 'observation',
      summary: 'Test',
      guidance: 'Test',
      model: 'claude-haiku',
    }, ctx.engine);

    expect(output).not.toContain('Capability:');
  });

  it('should still store the note correctly regardless of model param', async () => {
    const output = await handleStore({
      title: 'Model Store Test',
      content: 'Important knowledge',
      kind: 'reference',
      summary: 'Test storage with model',
      guidance: 'Test guidance',
      model: 'gpt-4o-mini',
    }, ctx.engine);

    expect(output).toContain('Knowledge stored (created)');
    expect(output).toContain('Kind: reference');

    const notes = ctx.engine.search('Important knowledge');
    expect(notes.length).toBe(1);
    expect(notes[0].title).toBe('Model Store Test');
  });
});

describe('MCP Tool: knowledge-maintain unlinked', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should detect unlinked notes with no links', async () => {
    ctx.engine.store('Standalone note', { title: 'Unlinked A', kind: 'reference' });
    ctx.engine.store('Another standalone', { title: 'Unlinked B', kind: 'observation' });

    const output = await handleMaintain({ action: 'unlinked' }, ctx.engine, ctx.config);
    expect(output).toContain('Unlinked Notes (2)');
    expect(output).toContain('Unlinked A');
    expect(output).toContain('Unlinked B');
  });

  it('should exclude archived notes from unlinked detection', async () => {
    ctx.engine.store('Archived note', { title: 'Old Note', kind: 'reference', status: 'archived' });
    ctx.engine.store('Active unlinked', { title: 'Active Note', kind: 'observation' });

    const output = await handleMaintain({ action: 'unlinked' }, ctx.engine, ctx.config);
    expect(output).toContain('Active Note');
    expect(output).not.toContain('Old Note');
  });

  it('should not list notes that have outgoing links', async () => {
    const target = ctx.engine.store('Target note', { title: 'Target', kind: 'reference' });
    ctx.engine.store(`Links to [[${target.id}]]`, { title: 'Linker', kind: 'observation' });

    const output = await handleMaintain({ action: 'unlinked' }, ctx.engine, ctx.config);
    expect(output).not.toContain('Linker');
  });

  it('should not list notes that have incoming links', async () => {
    const target = ctx.engine.store('Target content', { title: 'Target', kind: 'reference' });
    ctx.engine.store(`See also [[${target.id}]]`, { title: 'Source', kind: 'observation' });

    const output = await handleMaintain({ action: 'unlinked' }, ctx.engine, ctx.config);
    expect(output).not.toContain('Target');
  });

  it('should return clean message when no unlinked notes', async () => {
    const noteA = ctx.engine.store('Note A content', { title: 'Note A', kind: 'reference' });
    ctx.engine.store(`References [[${noteA.id}]]`, { title: 'Note B', kind: 'observation' });

    const output = await handleMaintain({ action: 'unlinked' }, ctx.engine, ctx.config);
    expect(output).toContain('No unlinked notes found');
  });

  it('should not flag notes with broken wikilinks as unlinked', async () => {
    ctx.engine.store('See [[9999999999999999-nonexistent]]', { title: 'Has Broken Link', kind: 'reference' });

    const output = await handleMaintain({ action: 'unlinked' }, ctx.engine, ctx.config);
    expect(output).not.toContain('Has Broken Link');
  });

  it('should not flag as unlinked when note has wikilink syntax to archived target', async () => {
    const target = ctx.engine.store('Target content', { title: 'Target', kind: 'reference' });
    ctx.engine.store(`Links to [[${target.id}]]`, { title: 'Linker To Archived', kind: 'observation' });
    ctx.engine.archive(target.id);

    const output = await handleMaintain({ action: 'unlinked' }, ctx.engine, ctx.config);
    expect(output).not.toContain('Linker To Archived');
  });
});

describe('MCP Tool: knowledge-maintain broken-links', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should detect broken wikilinks with line numbers', async () => {
    ctx.engine.store('See [[9999999999999999-nonexistent]]', { title: 'Has Broken Link', kind: 'reference' });

    const output = await handleMaintain({ action: 'broken-links' }, ctx.engine, ctx.config);
    expect(output).toContain('Broken Wikilinks');
    expect(output).toContain('Has Broken Link');
    expect(output).toContain('nonexistent');
    expect(output).toContain('content:');
  });

  it('should not flag valid wikilinks', async () => {
    const target = ctx.engine.store('Valid target', { title: 'Target Note', kind: 'reference' });
    ctx.engine.store(`See [[${target.id}]]`, { title: 'Linker', kind: 'observation' });

    const output = await handleMaintain({ action: 'broken-links' }, ctx.engine, ctx.config);
    expect(output).toContain('No broken wikilinks found');
  });

  it('should exclude archived notes from broken link check', async () => {
    ctx.engine.store('See [[9999999999999999-fake]]', {
      title: 'Archived With Broken',
      kind: 'reference',
      status: 'archived',
    });

    const output = await handleMaintain({ action: 'broken-links' }, ctx.engine, ctx.config);
    expect(output).toContain('No broken wikilinks found');
  });

  it('should return clean message when no broken links', async () => {
    ctx.engine.store('No links here', { title: 'Plain Note', kind: 'observation' });

    const output = await handleMaintain({ action: 'broken-links' }, ctx.engine, ctx.config);
    expect(output).toContain('No broken wikilinks found');
  });
});

describe('MCP Tool: knowledge-maintain link-health', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should return clean message when no issues', async () => {
    const noteA = ctx.engine.store('Note A content', { title: 'Note A', kind: 'reference' });
    const noteB = ctx.engine.store(`References [[${noteA.id}]]`, { title: 'Note B', kind: 'reference' });
    // Make bidirectional
    ctx.engine.store(`Links back to [[${noteB.id}]]`, { title: 'Note A', kind: 'reference', existingId: noteA.id });

    const output = await handleMaintain({ action: 'link-health' }, ctx.engine, ctx.config);
    expect(output).toContain('all clear');
  });

  it('should detect one-way links', async () => {
    const target = ctx.engine.store('Target content', { title: 'Target Note', kind: 'reference' });
    ctx.engine.store(`Links to [[${target.id}]]`, { title: 'Source Note', kind: 'observation' });

    const output = await handleMaintain({ action: 'link-health' }, ctx.engine, ctx.config);
    expect(output).toContain('One-Way Links (1)');
    expect(output).toContain('Source Note');
    expect(output).toContain('Target Note');
    expect(output).toContain('no reverse link');
  });

  it('should not flag bidirectional links as one-way', async () => {
    const noteA = ctx.engine.store('Note A content', { title: 'Note A', kind: 'reference' });
    const noteB = ctx.engine.store(`Links to [[${noteA.id}]]`, { title: 'Note B', kind: 'reference' });
    // Update A to link back to B
    ctx.engine.store(`Updated to link back [[${noteB.id}]]`, { title: 'Note A', kind: 'reference', existingId: noteA.id });

    const output = await handleMaintain({ action: 'link-health' }, ctx.engine, ctx.config);
    expect(output).not.toContain('One-Way Links');
  });

  it('should combine unlinked notes, broken links, and one-way links', async () => {
    // Unlinked
    ctx.engine.store('Standalone note', { title: 'Lonely Note', kind: 'reference' });
    // Broken link
    ctx.engine.store('See [[9999999999999999-nonexistent]]', { title: 'Broken Linker', kind: 'reference' });
    // One-way link
    const target = ctx.engine.store('Target only', { title: 'One Way Target', kind: 'reference' });
    ctx.engine.store(`See [[${target.id}]]`, { title: 'One Way Source', kind: 'observation' });

    const output = await handleMaintain({ action: 'link-health' }, ctx.engine, ctx.config);
    expect(output).toContain('Link Health Report');
    expect(output).toContain('Unlinked Notes (1)');
    expect(output).toContain('Lonely Note');
    expect(output).toContain('Broken Wikilinks (1)');
    expect(output).toContain('nonexistent');
    expect(output).toContain('One-Way Links (1)');
    expect(output).toContain('One Way Source');
    expect(output).toContain('Unlinked: 1 | Broken: 1 | One-way: 1');
  });

  it('should exclude archived notes from one-way link detection', async () => {
    const target = ctx.engine.store('Target content', { title: 'Archived Target', kind: 'reference' });
    ctx.engine.store(`Links to [[${target.id}]]`, { title: 'Active Source', kind: 'observation' });
    ctx.engine.archive(target.id);

    const output = await handleMaintain({ action: 'link-health' }, ctx.engine, ctx.config);
    expect(output).not.toContain('One-Way Links');
  });

  it('should show summary counts', async () => {
    const target = ctx.engine.store('Target content', { title: 'Target', kind: 'reference' });
    ctx.engine.store(`Links to [[${target.id}]]`, { title: 'Source', kind: 'observation' });

    const output = await handleMaintain({ action: 'link-health' }, ctx.engine, ctx.config);
    expect(output).toContain('Unlinked: 0');
    expect(output).toContain('Broken: 0');
    expect(output).toContain('One-way: 1');
  });

  it('should exclude structural notes (index/log) from one-way link detection', async () => {
    // Create a content note
    const contentNote = ctx.engine.store('Content note', { title: 'Content Note', kind: 'reference', tags: ['project:testproj'] });
    // Simulate an index note that links to contentNote but contentNote doesn't link back
    // Index notes are auto-generated navigation; they intentionally link out without expecting reciprocal links
    ctx.engine.store(`Project index: [[${contentNote.id}]]`, { title: 'testproj Index', kind: 'index', tags: ['project:testproj'] });

    const output = await handleMaintain({ action: 'link-health' }, ctx.engine, ctx.config);
    expect(output).not.toContain('One-Way Links');
  });
});

describe('MCP Tool: knowledge-maintain stats link health', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should surface one-way link count in health summary', async () => {
    const target = ctx.engine.store('Target content', { title: 'Target', kind: 'reference' });
    ctx.engine.store(`Links to [[${target.id}]]`, { title: 'Source', kind: 'observation' });

    const output = await handleMaintain({ action: 'stats' }, ctx.engine, ctx.config);
    expect(output).toContain('## Link Health');
    expect(output).toContain('1 one-way');
    expect(output).toContain('knowledge-maintain link-health');
  });

  it('should surface unlinked note count in health summary', async () => {
    ctx.engine.store('Standalone note', { title: 'Standalone', kind: 'reference' });

    const output = await handleMaintain({ action: 'stats' }, ctx.engine, ctx.config);
    expect(output).toContain('## Link Health');
    expect(output).toContain('1 unlinked');
    expect(output).toContain('knowledge-maintain link-health');
  });

  it('should show all clear when no link issues', async () => {
    const noteA = ctx.engine.store('Note A content', { title: 'Note A', kind: 'reference' });
    const noteB = ctx.engine.store(`References [[${noteA.id}]]`, { title: 'Note B', kind: 'reference' });
    ctx.engine.store(`Links back to [[${noteB.id}]]`, { title: 'Note A', kind: 'reference', existingId: noteA.id });

    const output = await handleMaintain({ action: 'stats' }, ctx.engine, ctx.config);
    expect(output).toContain('## Link Health');
    expect(output).toContain('All clear');
  });
});

describe('MCP Tool: knowledge-maintain full with link-health', () => {
  let ctx: TestContext;
  const originalFetch = globalThis.fetch;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => {
    cleanupTestHarness(ctx);
    globalThis.fetch = originalFetch;
    clearVersionCheckCache();
  });

  it('should run link-health step in full composite', async () => {
    // Create an unlinked note — survives rebuild regardless of file ordering
    ctx.engine.store('Standalone content', { title: 'Standalone', kind: 'reference' });

    globalThis.fetch = (async () => { throw new Error('offline'); }) as any;
    const output = await handleMaintain({ action: 'full' }, ctx.engine, ctx.config);
    expect(output).toContain('Link Health');
    expect(output).toContain('Unlinked Notes');
    expect(output).toContain('Standalone');
  });
});

describe('MCP Tool: knowledge-maintain review (stale fleeting archive)', () => {
  let ctx: TestContext;
  const daysAgo = (days: number): number => Date.now() - (days * 24 * 60 * 60 * 1000);

  const setCreatedAt = (noteId: string, timestamp: number): void => {
    (ctx.engine as any).db.prepare('UPDATE notes SET created_at = ? WHERE id = ?').run(timestamp, noteId);
  };

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should surface stale fleeting notes older than autoArchiveFleetingDays', async () => {
    const result = ctx.engine.store('Old fleeting', { title: 'Ancient Note', kind: 'observation' });
    setCreatedAt(result.id, daysAgo(100));

    const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    expect(output).toContain('Stale Fleeting Notes');
    expect(output).toContain('Ancient Note');
    expect(output).toContain('100 days old');
  });

  it('should not surface fleeting notes younger than threshold', async () => {
    const result = ctx.engine.store('Recent fleeting', { title: 'Fresh Note', kind: 'observation' });
    setCreatedAt(result.id, daysAgo(30));

    const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    expect(output).not.toContain('Stale Fleeting Notes');
  });

  it('should not duplicate stale notes in the fleeting review section', async () => {
    const result = ctx.engine.store('Very old note', { title: 'Stale Duplicate Check', kind: 'observation' });
    setCreatedAt(result.id, daysAgo(100));

    const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    expect(output).toContain('Stale Fleeting Notes');
    expect(output).toContain('Stale Duplicate Check');

    const staleSection = output.indexOf('Stale Fleeting Notes');
    const candidatesSection = output.indexOf('Review Candidates');
    if (candidatesSection !== -1) {
      const candidatesContent = output.substring(candidatesSection, staleSection > candidatesSection ? staleSection : undefined);
      expect(candidatesContent).not.toContain('Stale Duplicate Check');
    }
  });

  it('should surface old unaccessed permanent notes as review candidates', async () => {
    const result = ctx.engine.store('Old permanent', { title: 'Old Perm', kind: 'reference', status: 'permanent' });
    setCreatedAt(result.id, daysAgo(200));

    const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    expect(output).toContain('Old Perm');
    expect(output).toContain('status: permanent');
  });

  it('should not surface archived notes', async () => {
    const result = ctx.engine.store('Old archived', { title: 'Already Archived', kind: 'observation', status: 'archived' });
    setCreatedAt(result.id, daysAgo(200));

    const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    expect(output).not.toContain('Already Archived');
  });

  it('should not flag recently accessed notes as stale even if created long ago', async () => {
    const result = ctx.engine.store('Old but active', { title: 'Recently Accessed', kind: 'observation' });
    setCreatedAt(result.id, daysAgo(200));
    const recentAccess = Date.now() - (2 * 24 * 60 * 60 * 1000);
    (ctx.engine as any).db.prepare('UPDATE notes SET last_accessed_at = ? WHERE id = ?').run(recentAccess, result.id);

    const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    expect(output).not.toContain('Stale Fleeting Notes');
  });

  it('should respect custom autoArchiveFleetingDays config', async () => {
    const result = ctx.engine.store('Borderline fleeting', { title: 'Borderline', kind: 'observation' });
    setCreatedAt(result.id, daysAgo(45));

    const customConfig = { ...ctx.config, lifecycle: { ...ctx.config.lifecycle, autoArchiveFleetingDays: 30 } };
    const output = await handleMaintain({ action: 'review' }, ctx.engine, customConfig);
    expect(output).toContain('Stale Fleeting Notes');
    expect(output).toContain('Borderline');
  });

  it('should not flag note just under the threshold', async () => {
    const result = ctx.engine.store('Boundary note', { title: 'Just Under 90', kind: 'observation' });
    setCreatedAt(result.id, daysAgo(89));

    const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    expect(output).not.toContain('Stale Fleeting Notes');
  });

  it('should flag note just over the threshold', async () => {
    const result = ctx.engine.store('Over boundary', { title: 'Just Over 90', kind: 'observation' });
    setCreatedAt(result.id, daysAgo(91));

    const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    expect(output).toContain('Stale Fleeting Notes');
    expect(output).toContain('Just Over 90');
  });

  it('should guard against zero autoArchiveFleetingDays config', async () => {
    ctx.engine.store('Fresh note', { title: 'Should Not Be Stale', kind: 'observation' });

    const zeroConfig = { ...ctx.config, lifecycle: { ...ctx.config.lifecycle, autoArchiveFleetingDays: 0 } };
    const output = await handleMaintain({ action: 'review' }, ctx.engine, zeroConfig);
    expect(output).not.toContain('Stale Fleeting Notes');
  });

  it('should guard against negative autoArchiveFleetingDays config', async () => {
    ctx.engine.store('Fresh note', { title: 'Not Stale Either', kind: 'observation' });

    const negConfig = { ...ctx.config, lifecycle: { ...ctx.config.lifecycle, autoArchiveFleetingDays: -10 } };
    const output = await handleMaintain({ action: 'review' }, ctx.engine, negConfig);
    expect(output).not.toContain('Stale Fleeting Notes');
  });

  it('should handle all fleeting notes being stale', async () => {
    const r1 = ctx.engine.store('Old one', { title: 'All Stale A', kind: 'observation' });
    const r2 = ctx.engine.store('Old two', { title: 'All Stale B', kind: 'reference' });
    setCreatedAt(r1.id, daysAgo(120));
    setCreatedAt(r2.id, daysAgo(100));

    const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    expect(output).toContain('Stale Fleeting Notes (2');
    expect(output).toContain('All Stale A');
    expect(output).toContain('All Stale B');
    // No candidates section when all notes are stale
    expect(output).not.toContain('## Review Candidates');
  });

  it('should separate stale notes from review candidates when mixed ages', async () => {
    const old = ctx.engine.store('Old note', { title: 'Stale One', kind: 'observation' });
    const recent = ctx.engine.store('Recent note', { title: 'Review One', kind: 'observation' });
    setCreatedAt(old.id, daysAgo(100));
    setCreatedAt(recent.id, daysAgo(20));

    const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    expect(output).toContain('## Review Candidates');
    expect(output).toContain('Review One');
    expect(output).toContain('Stale Fleeting Notes');
    expect(output).toContain('Stale One');
    // Stale notes are excluded from candidates via SQL, not post-filtered
    expect(output).not.toMatch(/### \[\d+\].*Stale One/);  // Not in numbered candidates
  });
});

describe('MCP Tool: knowledge-maintain review (enhanced curation)', () => {
  let ctx: TestContext;
  const daysAgo = (days: number): number => Date.now() - (days * 24 * 60 * 60 * 1000);

  type TestDb = { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } };

  const db = (): TestDb => (ctx.engine as unknown as { db: TestDb }).db;

  const setCreatedAt = (noteId: string, timestamp: number): void => {
    db().prepare('UPDATE notes SET created_at = ? WHERE id = ?').run(timestamp, noteId);
  };

  const sectionFor = (output: string, title: string): string => {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headerPattern = new RegExp(`### \\[\\d+\\][^\\n]*"${escaped}"`);
    const match = headerPattern.exec(output);
    if (!match) return '';
    const start = match.index;
    const next = output.indexOf('\n### [', start + 1);
    return output.slice(start, next === -1 ? undefined : next);
  };

  beforeEach(() => { ctx = createTestHarness({ telemetryEnabled: true }); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should show backlink signals in review output', async () => {
    const noteA = ctx.engine.store('Links to another note', { title: 'Source Note', kind: 'observation' });
    const noteB = ctx.engine.store('Linked note', { title: 'Target Note', kind: 'observation' });
    ctx.engine.syncLinks(noteA.id, `[[${noteB.id}|test]]`);
    setCreatedAt(noteA.id, daysAgo(20));
    setCreatedAt(noteB.id, daysAgo(20));

    const output = await handleMaintain({ action: 'review', limit: 10 }, ctx.engine, ctx.config);

    expect(sectionFor(output, 'Target Note')).toContain('Backlinks: 1');
    expect(sectionFor(output, 'Source Note')).toContain('Backlinks: 0 (unlinked)');
  });

  it('should recommend promote when accesses meet the threshold', async () => {
    const note = ctx.engine.store('Accessed note', { title: 'Promotion Candidate', kind: 'observation' });
    setCreatedAt(note.id, daysAgo(50));
    for (let i = 0; i < ctx.config.lifecycle.promotionThreshold; i++) {
      ctx.engine.recordAccess(note.id);
    }

    const output = await handleMaintain({ action: 'review', limit: 10 }, ctx.engine, ctx.config);

    expect(output).toContain('PROMOTE');
    expect(output).toContain(`Accessed ${ctx.config.lifecycle.promotionThreshold} times`);
  });

  it('should recommend archive for zero-access old unlinked notes', async () => {
    const note = ctx.engine.store('Stale note', { title: 'Unlinked Archive Candidate', kind: 'observation' });
    setCreatedAt(note.id, daysAgo(50));

    const output = await handleMaintain({ action: 'review', limit: 10 }, ctx.engine, ctx.config);

    expect(output).toContain('ARCHIVE');
    expect(output).toContain('no backlinks');
  });

  it('should recommend review (not archive) when backlinks exist', async () => {
    const noteA = ctx.engine.store('Source content', { title: 'Backlink Source', kind: 'observation' });
    const noteB = ctx.engine.store('Target content', { title: 'Backlinked Review Candidate', kind: 'observation' });
    ctx.engine.syncLinks(noteA.id, `[[${noteB.id}|test]]`);
    setCreatedAt(noteA.id, daysAgo(10));
    setCreatedAt(noteB.id, daysAgo(50));

    const customConfig = { ...ctx.config, lifecycle: { ...ctx.config.lifecycle, exemptKinds: [] } };
    const output = await handleMaintain({ action: 'review', limit: 10 }, ctx.engine, customConfig);
    const targetSection = sectionFor(output, 'Backlinked Review Candidate');

    expect(targetSection).toContain('REVIEW');
    expect(targetSection).toContain('backlink(s)');
    expect(targetSection).not.toContain('ARCHIVE');
  });

  it('should recommend review for young notes', async () => {
    const note = ctx.engine.store('Needs judgment', { title: 'Manual Review Candidate', kind: 'observation' });
    setCreatedAt(note.id, daysAgo(16));
    ctx.engine.recordAccess(note.id);

    const output = await handleMaintain({ action: 'review', days: 14, limit: 10 }, ctx.engine, ctx.config);

    expect(output).toContain('REVIEW');
    expect(output).toContain('needs manual review');
  });

  it('should use numbered candidate format', async () => {
    const first = ctx.engine.store('First note', { title: 'Numbered One', kind: 'observation' });
    const second = ctx.engine.store('Second note', { title: 'Numbered Two', kind: 'reference' });
    setCreatedAt(first.id, daysAgo(20));
    setCreatedAt(second.id, daysAgo(20));

    const output = await handleMaintain({ action: 'review', limit: 10 }, ctx.engine, ctx.config);

    expect(output).toContain('## Review Candidates');
    expect(output).toContain('### [1]');
    expect(output).toContain('### [2]');
  });

  it('should show oversized signal inline', async () => {
    const content = Array(120).fill('word').join(' ');
    const note = ctx.engine.store(content, { title: 'Inline Oversized', kind: 'personalization' });
    setCreatedAt(note.id, daysAgo(20));

    const customConfig = { ...ctx.config, lifecycle: { ...ctx.config.lifecycle, exemptKinds: [] } };
    const output = await handleMaintain({ action: 'review', limit: 10 }, ctx.engine, customConfig);

    expect(sectionFor(output, 'Inline Oversized')).toContain('oversized');
    expect(sectionFor(output, 'Inline Oversized')).toContain('target: ~50');
  });

  it('should combine fleeting and permanent candidates in one numbered list', async () => {
    const fleeting = ctx.engine.store('Fleeting content', { title: 'Combined Fleeting', kind: 'observation' });
    const permanent = ctx.engine.store('Permanent content', { title: 'Combined Permanent', kind: 'reference', status: 'permanent' });
    setCreatedAt(fleeting.id, daysAgo(20));
    setCreatedAt(permanent.id, daysAgo(20));

    const output = await handleMaintain({ action: 'review', limit: 10 }, ctx.engine, ctx.config);

    expect(output).toContain('## Review Candidates (2 of 2)');
    expect(output).toContain('### [1] "Combined Fleeting"');
    expect(output).toContain('### [2] "Combined Permanent"');
  });
});

describe('MCP Tool: lifecycle field', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should default lifecycle based on kind', async () => {
    const output = await handleStore({
      title: 'A Decision',
      content: 'We chose X',
      kind: 'decision',
      summary: 'Chose X',
      guidance: 'Follow X',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Lifecycle: snapshot');
  });

  it('should default to living for personalization', async () => {
    const output = await handleStore({
      title: 'Dark Mode',
      content: 'I prefer dark mode',
      kind: 'personalization',
      summary: 'Prefers dark mode',
      guidance: 'Use dark mode',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Lifecycle: living');
  });

  it('should accept explicit lifecycle override', async () => {
    const output = await handleStore({
      title: 'Living Decision',
      content: 'An evolving decision',
      kind: 'decision',
      lifecycle: 'living',
      summary: 'Evolving decision',
      guidance: 'May change',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Lifecycle: living');
  });

  it('should auto-detect snapshot from date in title', async () => {
    const output = await handleStore({
      title: 'Analysis 2025-04-25',
      content: 'Point-in-time analysis',
      kind: 'observation',
      summary: 'April analysis',
      guidance: 'Historical reference',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Lifecycle: snapshot');
  });

  it('should not auto-detect snapshot when explicit lifecycle given', async () => {
    const output = await handleStore({
      title: 'Log 2025-04-25',
      content: 'Append-only log',
      kind: 'observation',
      lifecycle: 'append-only',
      summary: 'Daily log',
      guidance: 'Append only',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Lifecycle: append-only');
  });

  it('should reject updates to snapshot notes', () => {
    const result = ctx.engine.store('Immutable content', {
      title: 'Frozen Decision',
      kind: 'decision',
      lifecycle: 'snapshot',
      summary: 'Frozen',
      guidance: 'Do not change',
    });

    expect(() => {
      ctx.engine.store('Changed content', {
        title: 'Frozen Decision',
        kind: 'decision',
        existingId: result.id,
      });
    }).toThrow(LifecycleViolationError);
  });

  it('should reject non-extending updates to append-only notes', () => {
    const result = ctx.engine.store('Entry 1: started project', {
      title: 'Ops Log',
      kind: 'observation',
      lifecycle: 'append-only',
      summary: 'Ops log',
      guidance: 'Append only',
    });

    expect(() => {
      ctx.engine.store('Completely different content', {
        title: 'Ops Log',
        kind: 'observation',
        existingId: result.id,
      });
    }).toThrow(LifecycleViolationError);
  });

  it('should allow extending append-only notes', () => {
    const result = ctx.engine.store('Entry 1: started', {
      title: 'Ops Log',
      kind: 'observation',
      lifecycle: 'append-only',
      summary: 'Ops log',
      guidance: 'Append only',
    });

    const updated = ctx.engine.store('Entry 1: started\nEntry 2: continued', {
      title: 'Ops Log',
      kind: 'observation',
      existingId: result.id,
    });

    expect(updated.action).toBe('updated');
  });

  it('should persist lifecycle in frontmatter', async () => {
    const output = await handleStore({
      title: 'Snapshot Note',
      content: 'Frozen content',
      kind: 'decision',
      lifecycle: 'snapshot',
      summary: 'Snapshot',
      guidance: 'Immutable',
    }, ctx.engine, null, ctx.config);

    const idMatch = output.match(/ID: (\d+)/);
    const note = ctx.engine.getById(idMatch![1]);
    expect(note).not.toBeNull();
    expect(note!.lifecycle).toBe('snapshot');

    const fileContent = fs.readFileSync(note!.path, 'utf-8');
    expect(fileContent).toContain('lifecycle: snapshot');
  });

  it('should persist lifecycle in DB and read back', async () => {
    await handleStore({
      title: 'Append Log',
      content: 'Log entry',
      kind: 'observation',
      lifecycle: 'append-only',
      summary: 'Log',
      guidance: 'Append',
    }, ctx.engine, null, ctx.config);

    const results = ctx.engine.search('Log entry');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].lifecycle).toBe('append-only');
  });

  it('should disable slug detection when config says so', async () => {
    const noDetectConfig = {
      ...ctx.config,
      lifecycleDefaults: { ...ctx.config.lifecycleDefaults, detectSnapshotFromSlug: false },
    };
    const output = await handleStore({
      title: 'Procedure 2025-04-25',
      content: 'Dated procedure',
      kind: 'procedure',
      summary: 'Procedure',
      guidance: 'Follow steps',
    }, ctx.engine, null, noDetectConfig);

    expect(output).toContain('Lifecycle: living');
  });

  it('should slug-detect snapshot for kind that defaults to living', async () => {
    const output = await handleStore({
      title: 'Procedure 2025-04-25',
      content: 'Dated procedure',
      kind: 'procedure',
      summary: 'Procedure',
      guidance: 'Follow steps',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Lifecycle: snapshot');
  });

  it('should fall back to kind default for invalid lifecycle value', async () => {
    const output = await handleStore({
      title: 'Bad Lifecycle',
      content: 'Invalid lifecycle value',
      kind: 'decision',
      lifecycle: 'bogus',
      summary: 'Bad lifecycle',
      guidance: 'Test fallback',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Lifecycle: snapshot');
  });

  it('should filter search results by lifecycle', async () => {
    await handleStore({
      title: 'Living Reference',
      content: 'A living reference note about search',
      kind: 'reference',
      lifecycle: 'living',
      summary: 'Living ref',
      guidance: 'Use it',
    }, ctx.engine, null, ctx.config);

    await handleStore({
      title: 'Snapshot Reference',
      content: 'A snapshot reference note about search',
      kind: 'reference',
      lifecycle: 'snapshot',
      summary: 'Snapshot ref',
      guidance: 'Frozen',
    }, ctx.engine, null, ctx.config);

    const living = handleSearch({ query: 'reference note search', lifecycle: 'living' }, ctx.engine);
    const snapshot = handleSearch({ query: 'reference note search', lifecycle: 'snapshot' }, ctx.engine);

    expect(living).toContain('Living ref');
    expect(living).not.toContain('Snapshot ref');
    expect(snapshot).toContain('Snapshot ref');
    expect(snapshot).not.toContain('Living ref');
  });

  it('should allow updating living notes freely', () => {
    const result = ctx.engine.store('Original content', {
      title: 'Mutable Note',
      kind: 'procedure',
      lifecycle: 'living',
    });

    const updated = ctx.engine.store('Completely rewritten content', {
      title: 'Mutable Note',
      kind: 'procedure',
      existingId: result.id,
    });

    expect(updated.action).toBe('updated');
  });

  it('should normalize trailing whitespace in append-only validation', () => {
    const result = ctx.engine.store('Entry 1\n', {
      title: 'Whitespace Log',
      kind: 'observation',
      lifecycle: 'append-only',
    });

    const updated = ctx.engine.store('Entry 1\nEntry 2', {
      title: 'Whitespace Log',
      kind: 'observation',
      existingId: result.id,
    });

    expect(updated.action).toBe('updated');
  });

  it('should include note title and ID in LifecycleViolationError', () => {
    const result = ctx.engine.store('Frozen', {
      title: 'My Snapshot',
      kind: 'decision',
      lifecycle: 'snapshot',
    });

    expect(() =>
      ctx.engine.store('Changed', { title: 'My Snapshot', kind: 'decision', existingId: result.id }),
    ).toThrow(LifecycleViolationError);

    expect(() =>
      ctx.engine.store('Changed', { title: 'My Snapshot', kind: 'decision', existingId: result.id }),
    ).toThrow(/My Snapshot/);

    expect(() =>
      ctx.engine.store('Changed', { title: 'My Snapshot', kind: 'decision', existingId: result.id }),
    ).toThrow(new RegExp(result.id));
  });

  it('should render lifecycle attribute in XML only for non-living notes', async () => {
    await handleStore({
      title: 'Snapshot for Render',
      content: 'Frozen for rendering test',
      kind: 'decision',
      lifecycle: 'snapshot',
      summary: 'Snapshot render',
      guidance: 'Check XML',
    }, ctx.engine, null, ctx.config);

    await handleStore({
      title: 'Living for Render',
      content: 'Living for rendering test',
      kind: 'procedure',
      lifecycle: 'living',
      summary: 'Living render',
      guidance: 'Check XML',
    }, ctx.engine, null, ctx.config);

    const snapshotResults = ctx.engine.search('Frozen for rendering');
    const livingResults = ctx.engine.search('Living for rendering');

    expect(snapshotResults.length).toBeGreaterThan(0);
    expect(livingResults.length).toBeGreaterThan(0);

    const snapshotXml = renderNoteForSearch(snapshotResults[0]);
    const livingXml = renderNoteForSearch(livingResults[0]);

    expect(snapshotXml).toContain('lifecycle="snapshot"');
    expect(livingXml).not.toContain('lifecycle=');
  });

  it('should preserve append-only lifecycle on update without explicit lifecycle param', () => {
    const result = ctx.engine.store('Entry 1', {
      title: 'Preserved Log',
      kind: 'observation',
      lifecycle: 'append-only',
    });

    ctx.engine.store('Entry 1\nEntry 2', {
      title: 'Preserved Log',
      kind: 'observation',
      existingId: result.id,
    });

    const note = ctx.engine.getById(result.id);
    expect(note).not.toBeNull();
    expect(note!.lifecycle).toBe('append-only');

    expect(() =>
      ctx.engine.store('Completely rewritten', {
        title: 'Preserved Log',
        kind: 'observation',
        existingId: result.id,
      }),
    ).toThrow(LifecycleViolationError);
  });

  it('should preserve lifecycle through rebuildFromFiles', async () => {
    await handleStore({
      title: 'Rebuild Test Note',
      content: 'Content for rebuild lifecycle test',
      kind: 'observation',
      lifecycle: 'append-only',
      summary: 'Rebuild test',
      guidance: 'Check lifecycle persists',
    }, ctx.engine, null, ctx.config);

    const beforeRebuild = ctx.engine.search('rebuild lifecycle test');
    expect(beforeRebuild.length).toBeGreaterThan(0);
    expect(beforeRebuild[0].lifecycle).toBe('append-only');

    ctx.engine.rebuildFromFiles();

    const afterRebuild = ctx.engine.search('rebuild lifecycle test');
    expect(afterRebuild.length).toBeGreaterThan(0);
    expect(afterRebuild[0].lifecycle).toBe('append-only');
  });
});

describe('Domain note kind', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should store domain note with permanent status by default', async () => {
    const output = await handleStore({
      title: 'MyApp Domain',
      content: 'Core domain knowledge for MyApp.',
      kind: 'domain',
      project: 'myapp',
      summary: 'MyApp domain guide',
      guidance: 'Read before project-scoped work',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Status: permanent');
  });

  it('should store domain note with living lifecycle by default', async () => {
    const output = await handleStore({
      title: 'MyApp Domain',
      content: 'Core domain knowledge for MyApp.',
      kind: 'domain',
      project: 'myapp',
      summary: 'MyApp domain guide',
      guidance: 'Read before project-scoped work',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Lifecycle: living');
  });

  it('should reject domain note without project', async () => {
    const output = await handleStore({
      title: 'Unscoped Domain',
      content: 'Missing project scope.',
      kind: 'domain',
      summary: 'Invalid domain note',
      guidance: 'Always provide a project',
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('require a project');
  });

  it('should reject duplicate domain note for same project', async () => {
    const first = await handleStore({
      title: 'MyApp Domain',
      content: 'Primary domain note.',
      kind: 'domain',
      project: 'myapp',
      summary: 'Primary domain guide',
      guidance: 'Use this note',
    }, ctx.engine, null, ctx.config);

    const firstId = first.match(/ID: (\d+)/)?.[1];
    expect(firstId).toBeDefined();

    const second = await handleStore({
      title: 'MyApp Domain Duplicate',
      content: 'Duplicate domain note.',
      kind: 'domain',
      project: 'myapp',
      summary: 'Duplicate domain guide',
      guidance: 'Should be rejected',
    }, ctx.engine, null, ctx.config);

    expect(second).toContain('already exists for project "myapp"');
    expect(second).toContain(firstId!);
  });

  it('should allow domain notes for different projects', async () => {
    const outputA = await handleStore({
      title: 'MyApp Domain',
      content: 'Domain note for MyApp.',
      kind: 'domain',
      project: 'myapp',
      summary: 'MyApp domain guide',
      guidance: 'Use for MyApp work',
    }, ctx.engine, null, ctx.config);

    const outputB = await handleStore({
      title: 'OtherApp Domain',
      content: 'Domain note for OtherApp.',
      kind: 'domain',
      project: 'otherapp',
      summary: 'OtherApp domain guide',
      guidance: 'Use for OtherApp work',
    }, ctx.engine, null, ctx.config);

    expect(outputA).toContain('Knowledge stored (created)');
    expect(outputB).toContain('Knowledge stored (created)');
    expect(ctx.engine.getByKind('domain')).toHaveLength(2);
  });

  it('should auto-add project tag to domain note', async () => {
    await handleStore({
      title: 'MyApp Domain',
      content: 'Tagged domain note.',
      kind: 'domain',
      project: 'myapp',
      summary: 'Tagged domain guide',
      guidance: 'Check project tags',
    }, ctx.engine, null, ctx.config);

    const note = ctx.engine.getDomainNote('myapp');
    expect(note).not.toBeNull();
    expect(note!.tags).toContain('project:myapp');
  });

  it('should always-include domain note in project-scoped search', async () => {
    await handleStore({
      title: 'MyApp Domain',
      content: 'Canonical operating manual for MyApp.',
      kind: 'domain',
      project: 'myapp',
      summary: 'MyApp operating manual',
      guidance: 'Read first',
    }, ctx.engine, null, ctx.config);

    await handleStore({
      title: 'MyApp Query Match',
      content: 'Contains onboarding keyword for project search.',
      kind: 'observation',
      project: 'myapp',
      summary: 'Project note with keyword',
      guidance: 'Used for search ordering test',
    }, ctx.engine, null, ctx.config);

    const config = { ...getConfig(), search: { alwaysIncludeDomainNote: true } };
    const output = handleSearch({ query: 'onboarding', project: 'myapp' }, ctx.engine, null, config);

    const domainIndex = output.indexOf('MyApp operating manual');
    const regularIndex = output.indexOf('Project note with keyword');
    expect(domainIndex).toBeGreaterThan(-1);
    expect(regularIndex).toBeGreaterThan(-1);
    expect(domainIndex).toBeLessThan(regularIndex);
  });

  it('should return domain note even with zero FTS matches', async () => {
    await handleStore({
      title: 'MyApp Domain',
      content: 'Canonical operating manual for MyApp.',
      kind: 'domain',
      project: 'myapp',
      summary: 'MyApp operating manual',
      guidance: 'Read first',
    }, ctx.engine, null, ctx.config);

    const config = { ...getConfig(), search: { alwaysIncludeDomainNote: true } };
    const output = handleSearch({ query: 'totally-unrelated-query', project: 'myapp' }, ctx.engine, null, config);

    expect(output).toContain('Found 1 note(s):');
    expect(output).toContain('MyApp operating manual');
  });

  it('should not duplicate domain note if it matches search', async () => {
    await handleStore({
      title: 'MyApp Domain',
      content: 'This domain note documents foobar workflows.',
      kind: 'domain',
      project: 'myapp',
      summary: 'Foobar domain guide',
      guidance: 'Read first',
    }, ctx.engine, null, ctx.config);

    const config = { ...getConfig(), search: { alwaysIncludeDomainNote: true } };
    const output = handleSearch({ query: 'foobar', project: 'myapp' }, ctx.engine, null, config);
    const occurrences = output.match(/Foobar domain guide/g) ?? [];

    expect(occurrences).toHaveLength(1);
  });

  it('should not include domain note without project filter', async () => {
    await handleStore({
      title: 'MyApp Domain',
      content: 'Canonical operating manual for MyApp.',
      kind: 'domain',
      project: 'myapp',
      summary: 'MyApp operating manual',
      guidance: 'Read first',
    }, ctx.engine, null, ctx.config);

    const config = { ...getConfig(), search: { alwaysIncludeDomainNote: true } };
    const output = handleSearch({ query: 'totally-unrelated-query' }, ctx.engine, null, config);

    expect(output).toBe('No matching notes found. Try broader keywords or remove filters.');
  });

  it('should respect alwaysIncludeDomainNote=false config', async () => {
    await handleStore({
      title: 'MyApp Domain',
      content: 'Canonical operating manual for MyApp.',
      kind: 'domain',
      project: 'myapp',
      summary: 'MyApp operating manual',
      guidance: 'Read first',
    }, ctx.engine, null, ctx.config);

    const config = { ...getConfig(), search: { alwaysIncludeDomainNote: false } };
    const output = handleSearch({ query: 'totally-unrelated-query', project: 'myapp' }, ctx.engine, null, config);

    expect(output).toBe('No matching notes found. Try broader keywords or remove filters.');
  });

  it('should not include archived domain note', async () => {
    const storeOutput = await handleStore({
      title: 'MyApp Domain',
      content: 'Canonical operating manual for MyApp.',
      kind: 'domain',
      project: 'myapp',
      summary: 'MyApp operating manual',
      guidance: 'Read first',
    }, ctx.engine, null, ctx.config);

    const noteId = storeOutput.match(/ID: (\d+)/)?.[1];
    expect(noteId).toBeDefined();
    ctx.engine.archive(noteId!);

    const config = { ...getConfig(), search: { alwaysIncludeDomainNote: true } };
    const output = handleSearch({ query: 'totally-unrelated-query', project: 'myapp' }, ctx.engine, null, config);

    expect(output).toBe('No matching notes found. Try broader keywords or remove filters.');
  });

  it('should find domain note via getDomainNote()', async () => {
    await handleStore({
      title: 'MyApp Domain',
      content: 'Canonical operating manual for MyApp.',
      kind: 'domain',
      project: 'myapp',
      summary: 'MyApp operating manual',
      guidance: 'Read first',
    }, ctx.engine, null, ctx.config);

    const note = ctx.engine.getDomainNote('myapp');
    expect(note).not.toBeNull();
    expect(note!.title).toBe('MyApp Domain');
    expect(note!.kind).toBe('domain');
  });

  it('should return null for missing domain note', () => {
    expect(ctx.engine.getDomainNote('nonexistent')).toBeNull();
  });
});

describe('Index and log note kinds', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  const makeConfig = (
    overrides: {
      search?: Record<string, boolean>;
      navigation?: Record<string, boolean | number>;
    } = {},
  ) => {
    const base = getConfig();
    return {
      ...base,
      vault: ctx.tempDir,
      logLevel: ctx.config.logLevel,
      lifecycle: ctx.config.lifecycle,
      lifecycleDefaults: ctx.config.lifecycleDefaults,
      search: {
        ...base.search,
        ...ctx.config.search,
        ...overrides.search,
      },
      navigation: {
        ...base.navigation,
        ...ctx.config.navigation,
        ...overrides.navigation,
      },
    };
  };

  const storeProjectNote = async (
    title: string,
    project: string = 'myapp',
    config = makeConfig(),
    kind: 'observation' | 'domain' = 'observation',
   ) => await handleStore({
    title,
    content: `${title} content for ${project}`,
    kind,
    project,
    summary: `${title} summary`,
    guidance: `${title} guidance`,
  }, ctx.engine, null, config);

  const extractId = (output: string): string => {
    const noteId = output.match(/ID: (\d+)/)?.[1];
    expect(noteId).toBeDefined();
    return noteId!;
  };

  it('should auto-generate an index note for project-scoped notes', async () => {
    await storeProjectNote('Alpha Note');

    const indexNote = ctx.engine.getIndexNote('myapp');
    expect(indexNote).not.toBeNull();
    expect(indexNote!.kind).toBe('index');
  });

  it('should include Dataview queries in index content', async () => {
    await storeProjectNote('Linked Note');

    const indexNote = ctx.engine.getIndexNote('myapp');
    expect(indexNote).not.toBeNull();
    expect(indexNote!.content).toContain('```dataviewjs');
    expect(indexNote!.content).toContain('dv.pages(\'"projects/myapp/');
  });

  it('should exclude index notes from default search results', async () => {
    await storeProjectNote('Index Search Hidden');

    const output = handleSearch({ query: 'Index Search Hidden' }, ctx.engine, null, makeConfig());
    expect(output).not.toContain('myapp Index');
  });

  it('should return index notes when explicitly filtered by kind', async () => {
    await storeProjectNote('Index Search Visible');

    const output = handleSearch({ query: 'myapp', kind: 'index' }, ctx.engine, null, makeConfig());
    expect(output).toContain('# Myapp');
  });

  it('should rebuild the index when a second project note is stored', async () => {
    await storeProjectNote('First Indexed');
    const before = ctx.engine.getIndexNote('myapp');
    expect(before).not.toBeNull();
    expect(before!.content).toContain('```dataviewjs');

    await storeProjectNote('Second Indexed');
    const after = ctx.engine.getIndexNote('myapp');
    expect(after).not.toBeNull();
    expect(after!.content).toContain('```dataviewjs');
    expect(after!.content).toContain('dv.pages(\'"projects/myapp/');
  });

  it('should rebuild the index after archiving a note', async () => {
    const keepOutput = await storeProjectNote('Keep In Index');
    const archiveOutput = await storeProjectNote('Archive This');
    const archiveId = extractId(archiveOutput);

    expect(keepOutput).toContain('Knowledge stored');
    await handleMaintain({ action: 'archive', noteId: archiveId }, ctx.engine, makeConfig());

    const indexNote = ctx.engine.getIndexNote('myapp');
    expect(indexNote).not.toBeNull();
    expect(indexNote!.content).toContain('```dataviewjs');
    expect(indexNote!.content).toContain('dv.pages(\'"projects/myapp/');
  });

  it('should keep exactly one index note per project', async () => {
    await storeProjectNote('Project Note One');
    await storeProjectNote('Project Note Two');
    await storeProjectNote('Project Note Three');

    const indexNotes = ctx.engine.getByKind('index').filter(note => note.tags.includes('project:myapp'));
    expect(indexNotes).toHaveLength(1);
  });

  it('should auto-generate a log note with a Created entry', async () => {
    await storeProjectNote('Created Log Note');

    const logNote = ctx.engine.getLogNote('myapp');
    expect(logNote).not.toBeNull();
    expect(logNote!.content).toContain('Created observation: "Created Log Note"');
  });

  it('should format log entries with bold dates', async () => {
    await storeProjectNote('Bold Date Log');

    const logNote = ctx.engine.getLogNote('myapp');
    expect(logNote).not.toBeNull();
    expect(logNote!.content).toMatch(/- \*\*\d{4}-\d{2}-\d{2}\*\* — Created observation: "Bold Date Log"/);
  });

  it('should exclude log notes from default search results', async () => {
    await storeProjectNote('Log Search Hidden');

    const output = handleSearch({ query: 'Log Search Hidden' }, ctx.engine, null, makeConfig());
    expect(output).not.toContain('Operations Log');
  });

  it('should return log notes when explicitly filtered by kind', async () => {
    await storeProjectNote('Log Search Visible');

    const output = handleSearch({ query: 'Log Search Visible', kind: 'log' }, ctx.engine, null, makeConfig());
    expect(output).toContain('# Myapp Operations Log');
  });

  it('should accumulate log entries across multiple project note stores', async () => {
    await storeProjectNote('First Log Entry');
    await storeProjectNote('Second Log Entry');

    const logNote = ctx.engine.getLogNote('myapp');
    expect(logNote).not.toBeNull();
    const entries = logNote!.content.match(/^- \*\*/gm) ?? [];
    expect(entries).toHaveLength(2);
  });

  it('should append a Promoted entry to the log', async () => {
    const output = await storeProjectNote('Promote Me');
    const noteId = extractId(output);

    await handleMaintain({ action: 'promote', noteId }, ctx.engine, makeConfig());

    const logNote = ctx.engine.getLogNote('myapp');
    expect(logNote).not.toBeNull();
    expect(logNote!.content).toContain('Promoted "Promote Me" from fleeting to permanent');
  });

  it('should append an Archived entry to the log', async () => {
    const output = await storeProjectNote('Archive Me');
    const noteId = extractId(output);

    await handleMaintain({ action: 'archive', noteId }, ctx.engine, makeConfig());

    const logNote = ctx.engine.getLogNote('myapp');
    expect(logNote).not.toBeNull();
    expect(logNote!.content).toContain('Archived "Archive Me"');
  });

  it('should append a Deleted entry to the log', async () => {
    const output = await storeProjectNote('Delete Me');
    const noteId = extractId(output);

    await handleMaintain({ action: 'delete', noteId }, ctx.engine, makeConfig());

    const logNote = ctx.engine.getLogNote('myapp');
    expect(logNote).not.toBeNull();
    expect(logNote!.content).toContain('Deleted "Delete Me"');
  });

  it('should store log notes with append-only lifecycle', async () => {
    await storeProjectNote('Append Only Log');

    const logNote = ctx.engine.getLogNote('myapp');
    expect(logNote).not.toBeNull();
    expect(logNote!.lifecycle).toBe('append-only');
  });

  it('should reject manual creation of structural kinds', async () => {
    const indexOutput = await handleStore({
      title: 'Manual Index',
      content: 'Should fail',
      kind: 'index',
      summary: 'Manual index summary',
      guidance: 'Do not create manually',
    }, ctx.engine, null, makeConfig());

    const logOutput = await handleStore({
      title: 'Manual Log',
      content: 'Should fail',
      kind: 'log',
      summary: 'Manual log summary',
      guidance: 'Do not create manually',
    }, ctx.engine, null, makeConfig());

    expect(indexOutput).toContain('Error: index notes are auto-generated');
    expect(logOutput).toContain('Error: log notes are auto-generated');
  });

  it('should return project overview with domain, index, and log sections', async () => {
    await storeProjectNote('MyApp Domain', 'myapp', makeConfig(), 'domain');
    await storeProjectNote('Overview Note');

    const output = handleOverview({ project: 'myapp' }, ctx.engine, makeConfig());
    expect(output).toContain('## Project Overview: myapp');
    expect(output).toContain('### Domain');
    expect(output).toContain('### Index');
    expect(output).toContain('### Recent Activity');
    expect(output).toContain('Overview Note');
  });

  it('should return a no-navigation message for unknown projects', () => {
    const output = handleOverview({ project: 'unknown-project' }, ctx.engine, makeConfig());
    expect(output).toContain('No navigation notes found for project "unknown-project"');
  });

  it('should respect the logEntries parameter in overview output', async () => {
    await storeProjectNote('Overview Entry One');
    await storeProjectNote('Overview Entry Two');
    await storeProjectNote('Overview Entry Three');

    const output = handleOverview({ project: 'myapp', logEntries: 2 }, ctx.engine, makeConfig());
    const recentActivity = output.split('### Recent Activity\n')[1] || '';
    expect(recentActivity).not.toContain('Overview Entry One');
    expect(recentActivity).toContain('Overview Entry Two');
    expect(recentActivity).toContain('Overview Entry Three');
    expect(output).toContain('(showing 2 of 3 entries)');
  });

  it('should work when only some navigation notes exist', async () => {
    const config = makeConfig({ navigation: { enableProjectIndex: false, enableProjectLog: false } });
    await storeProjectNote('Partial Domain', 'partial', config, 'domain');

    const output = handleOverview({ project: 'partial' }, ctx.engine, config);
    expect(output).toContain('### Domain');
    expect(output).toContain('(not yet generated — store a project-scoped note to trigger)');
  });

  it('should skip index generation when enableProjectIndex is false', async () => {
    const config = makeConfig({ navigation: { enableProjectIndex: false } });
    await storeProjectNote('No Index Generated', 'myapp', config);

    expect(ctx.engine.getIndexNote('myapp')).toBeNull();
  });

  it('should skip log generation when enableProjectLog is false', async () => {
    const config = makeConfig({ navigation: { enableProjectLog: false } });
    await storeProjectNote('No Log Generated', 'myapp', config);

    expect(ctx.engine.getLogNote('myapp')).toBeNull();
  });

  it('should include structural kinds in default search when excludeLogFromSearch is false', async () => {
    const config = makeConfig({ search: { excludeLogFromSearch: false } });
    await storeProjectNote('Structural Search Visible', 'myapp', config);

    const output = handleSearch({ query: 'Structural Search Visible' }, ctx.engine, null, config);
    expect(output).toContain('Structural Search Visible');
    expect(output).toContain('Myapp Operations Log');
  });

  it('should regenerate indexes for all projects during rebuild', async () => {
    const disabledConfig = makeConfig({ navigation: { enableProjectIndex: false, enableProjectLog: false } });
    await storeProjectNote('Rebuild Alpha', 'alpha', disabledConfig);
    await storeProjectNote('Rebuild Beta', 'beta', disabledConfig);

    expect(ctx.engine.getIndexNote('alpha')).toBeNull();
    expect(ctx.engine.getIndexNote('beta')).toBeNull();

    const output = await handleMaintain({ action: 'rebuild' }, ctx.engine, makeConfig());
    expect(output).toContain('Rebuilt index for 2 project(s).');
    expect(ctx.engine.getIndexNote('alpha')).not.toBeNull();
    expect(ctx.engine.getIndexNote('beta')).not.toBeNull();
  });
});
