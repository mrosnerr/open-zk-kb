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
import { renderNoteForAgent } from '../src/prompts.js';
import { getPendingMigrations, getMigrationById } from '../src/data-migrations.js';
import { handleStore, handleSearch, handleMaintain } from '../src/tool-handlers.js';
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
  const daysAgo = (days: number): number => Date.now() - (days * 24 * 60 * 60 * 1000);

  const setCreatedAt = (noteId: string, timestamp: number): void => {
    (ctx.engine as any).db.prepare('UPDATE notes SET created_at = ? WHERE id = ?').run(timestamp, noteId);
  };

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

  it('should skip ambiguous multiple-marker agent docs files during repair', async () => {
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agent-docs-'));

    try {
      process.env.XDG_CONFIG_HOME = tempRoot;
      const agentDocsPath = path.join(tempRoot, 'opencode', 'AGENTS.md');
      fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
      const original = 'Intro\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld A\n<!-- OPEN-ZK-KB:END -->\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld B\n<!-- OPEN-ZK-KB:END -->\n';
      fs.writeFileSync(agentDocsPath, original, 'utf-8');

      const output = await handleMaintain({ action: 'agent-docs', dryRun: false }, ctx.engine, ctx.config);
      expect(output).toContain('manual review recommended; skipped');
      expect(fs.readFileSync(agentDocsPath, 'utf-8')).toBe(original);
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

    const output = await handleMaintain({ action: 'review', limit: 10 }, ctx.engine, ctx.config);

    expect(output).toContain('## Review Queue');
    expect(output).toContain('### Fleeting Notes for Review (1 total)');
    expect(output).toContain('### Permanent Notes for Review (1 total)');
    expect(output).toContain('"Review Fleeting"');
    expect(output).toContain('"Review Permanent"');
    expect(output).toContain('## Next Steps:');
    expect(output).not.toContain('Oversized Notes');
  });

  it('should include archive/review recommendations and exclude promote-threshold notes', async () => {
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

    setCreatedAt(promoteCandidate.id, daysAgo(40));
    setCreatedAt(archiveCandidate.id, daysAgo(40));
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

    expect(output).not.toContain('"Promote Candidate"');
    expect(output).toContain('"Archive Candidate"');
    expect(output).toContain('"Review Candidate"');
    expect(output).not.toContain('| Promote');
    expect(output).toContain('Archive');
    expect(output).toContain('Review');
    expect(output).toContain('### Fleeting Notes for Review (2 total)');
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
    expect(fleetingOnly).toContain('### Fleeting Notes for Review (1 total)');
    expect(fleetingOnly).not.toContain('### Permanent Notes for Review');

    const permanentOnly = await handleMaintain(
      { action: 'review', filter: 'permanent', limit: 10 },
      ctx.engine,
      ctx.config,
    );
    expect(permanentOnly).toContain('### Permanent Notes for Review (1 total)');
    expect(permanentOnly).not.toContain('### Fleeting Notes for Review');
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

  it('should add client tag when client param provided', () => {
    handleStore({
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

  it('should auto-detect client from .opencode/ in content', () => {
    handleStore({
      title: 'OpenCode Config',
      content: 'Edit .opencode/config.json to change settings',
      kind: 'reference',
      summary: 'OpenCode config location',
      guidance: 'Edit config for settings',
    }, ctx.engine);

    const notes = ctx.engine.getByKind('reference');
    expect(notes[0].tags).toContain('client:opencode');
  });

  it('should auto-detect client from .claude/ in guidance', () => {
    handleStore({
      title: 'Claude Instructions',
      content: 'Project instructions go in the root',
      kind: 'reference',
      summary: 'Where to put project instructions',
      guidance: 'Add instructions to .claude/settings.json in project root',
    }, ctx.engine);

    const notes = ctx.engine.getByKind('reference');
    expect(notes[0].tags).toContain('client:claude-code');
  });

  it('should NOT auto-tag universal content', () => {
    handleStore({
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

  it('should warn on unrecognized client name', () => {
    const output = handleStore({
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

  it('should NOT warn on recognized client name', () => {
    const output = handleStore({
      title: 'Known Client Note',
      content: 'Some content',
      kind: 'reference',
      client: 'claude-code',
      summary: 'Test note',
      guidance: 'Test guidance',
    }, ctx.engine);

    expect(output).not.toContain('Unrecognized client');
  });

  it('should use explicit client over auto-detection', () => {
    handleStore({
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

  it('should not auto-tag when multiple clients detected (ambiguous)', () => {
    handleStore({
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

  it('should coexist client and project tags', () => {
    handleStore({
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
