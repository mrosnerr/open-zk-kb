import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createTestHarness, cleanupTestHarness } from './harness.js';
import type { TestContext } from './harness.js';
import { handleMine, handleStore } from '../src/tool-handlers.js';
import type { MineCandidate } from '../src/tool-handlers.js';
import { GitVersioning } from '../src/git-versioning.js';

function makeCandidate(overrides: Partial<MineCandidate> = {}): MineCandidate {
  return {
    title: 'Test Note',
    content: 'Some test content for the knowledge base',
    kind: 'observation',
    summary: 'A test observation',
    guidance: 'Use this for testing purposes',
    ...overrides,
  };
}

describe('knowledge-mine: validation', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
  });

  it('empty candidates array', async () => {
    const output = await handleMine({ project: 'test-project', candidates: [] }, ctx.engine, null, ctx.config);

    expect(output).toContain('No mining candidates provided');
    expect(output).toContain('at least one candidate');
    expect(output).not.toContain('Error:');
  });

  it('over 50 candidates', async () => {
    const candidates = Array.from({ length: 51 }, (_, index) => makeCandidate({ title: `Candidate ${index}` }));

    const output = await handleMine({ project: 'test-project', candidates }, ctx.engine, null, ctx.config);

    expect(output).toContain('Error: knowledge-mine accepts at most 50 candidates per batch');
    expect(output).toContain('received 51');
  });

  it('missing required field (title)', async () => {
    const output = await handleMine({ project: 'test-project', candidates: [makeCandidate({ title: '' })] }, ctx.engine, null, ctx.config);

    expect(output).toContain('Error: Candidate 1');
    expect(output).toContain('missing required field "title"');
  });

  it('missing required field (summary)', async () => {
    const output = await handleMine({ project: 'test-project', candidates: [makeCandidate({ summary: '   ' })] }, ctx.engine, null, ctx.config);

    expect(output).toContain('Error: Candidate 1');
    expect(output).toContain('missing required field "summary"');
  });

  it('structural kind (index)', async () => {
    const output = await handleMine({ project: 'test-project', candidates: [makeCandidate({ kind: 'index' })] }, ctx.engine, null, ctx.config);

    expect(output).toContain('Error: Candidate 1');
    expect(output).toContain('index notes are structural and auto-generated');
  });

  it('structural kind (log)', async () => {
    const output = await handleMine({ project: 'test-project', candidates: [makeCandidate({ kind: 'log' })] }, ctx.engine, null, ctx.config);

    expect(output).toContain('Error: Candidate 1');
    expect(output).toContain('log notes are structural and auto-generated');
  });

  it('domain kind uses the current project', async () => {
    const output = await handleMine({ project: 'test-project', candidates: [makeCandidate({ kind: 'domain' })] }, ctx.engine, null, ctx.config);

    expect(output).not.toContain('Error:');
    expect(output).toContain('⮕ STORE');
  });

  it('domain kind rejects a conflicting candidate project', async () => {
    const output = await handleMine({ project: 'test-project',
      candidates: [makeCandidate({ kind: 'domain', project: 'alpha' })],
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('candidate project conflicts with project:test-project');
  });
});

describe('knowledge-mine: dry-run classification', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
  });

  it('single candidate, empty KB', async () => {
    const output = await handleMine({ project: 'test-project', candidates: [makeCandidate()] }, ctx.engine, null, ctx.config);

    expect(output).toContain('⮕ STORE — No similar notes found');
    expect(output).not.toContain('↳ [');
    expect(output).toContain('Summary: 1 STORE, 0 SKIP, 0 REVIEW');
  });

  it('dry_run defaults to true', async () => {
    await handleMine({ project: 'test-project', candidates: [makeCandidate({ title: 'Default Dry Run Note' })] }, ctx.engine, null, ctx.config);

    const stats = ctx.engine.getStats();
    const results = ctx.engine.search('Default Dry Run Note', { limit: 10 });

    expect(stats.total).toBe(0);
    expect(results).toHaveLength(0);
  });

  it('candidate matching existing note', async () => {
    await handleStore({ project: 'test-project',
      title: 'Session Context Capture',
      content: 'Capture durable session context before ending work.',
      kind: 'observation',
      summary: 'Capture durable session context before ending work',
      guidance: 'Store durable session context before handoff.',
    }, ctx.engine, null, ctx.config);

    const output = await handleMine({ project: 'test-project',
      candidates: [makeCandidate({
        title: 'Session Context Capture',
        content: 'Capture durable session context before ending work with a concise handoff.',
        summary: 'Capture durable session context before ending work',
        guidance: 'Store concise handoff context before ending work.',
      })],
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('⮕ SKIP');
    expect(output).toContain('Similar to existing note by SimHash');
    expect(output).toContain('"Session Context Capture"');
    expect(output).toContain('Summary: 0 STORE, 1 SKIP, 0 REVIEW');
  });

  it('does not classify against notes hidden from the mining client', async () => {
    await handleStore({
      project: 'test-project', client: 'cursor',
      title: 'Cursor Private Duplicate',
      content: 'Capture this exact private duplicate phrase for one client.',
      kind: 'observation',
      summary: 'Capture this exact private duplicate phrase',
      guidance: 'Keep this duplicate private to Cursor.',
    }, ctx.engine, null, ctx.config);

    const candidate = makeCandidate({
      title: 'Candidate Duplicate Mirror',
      content: 'Capture this exact private duplicate phrase for one client.',
      summary: 'Capture this exact private duplicate phrase',
      guidance: 'Keep this duplicate private to the matching client.',
    });
    const hidden = await handleMine({ project: 'test-project', client: 'pi', candidates: [candidate] }, ctx.engine, null, ctx.config);
    const visible = await handleMine({ project: 'test-project', client: 'cursor', candidates: [candidate] }, ctx.engine, null, ctx.config);

    expect(hidden).not.toContain('"Cursor Private Duplicate"');
    expect(hidden).not.toContain('⮕ SKIP');
    expect(visible).toContain('⮕ SKIP');
    expect(visible).toContain('"Cursor Private Duplicate"');
  });

  it('candidate partially matching existing note', async () => {
    await handleStore({ project: 'test-project',
      title: 'Release Checklist',
      content: 'Run build, tests, and changelog checks before release.',
      kind: 'procedure',
      summary: 'Release checklist for build verification',
      guidance: 'Use this before publishing releases.',
    }, ctx.engine, null, ctx.config);

    const output = await handleMine({ project: 'test-project',
      candidates: [makeCandidate({
        title: 'Release Checklist Followup',
        content: 'Document deployment rollback ownership after a production incident.',
        kind: 'procedure',
        summary: 'Rollback ownership after production incident',
        guidance: 'Use this when assigning incident followup ownership.',
      })],
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('⮕ REVIEW — Keyword overlap found (FTS5 fallback)');
    expect(output).toContain('"Release Checklist"');
    expect(output).toContain('Summary: 0 STORE, 0 SKIP, 1 REVIEW');
  });

  it('intra-batch duplicate', async () => {
    const output = await handleMine({ project: 'test-project',
      candidates: [
        makeCandidate({
          title: 'Duplicate Candidate A',
          content: 'alpha beta gamma delta epsilon zeta eta theta iota kappa',
          summary: 'alpha beta gamma delta epsilon zeta eta theta iota kappa',
        }),
        makeCandidate({
          title: 'Duplicate Candidate B',
          content: 'kappa iota theta eta zeta epsilon delta gamma beta alpha',
          summary: 'alpha beta gamma delta epsilon zeta eta theta iota kappa',
        }),
      ],
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('### [2] "Duplicate Candidate B"');
    expect(output).toContain('⮕ SKIP — Duplicate of candidate 1');
    expect(output).toContain('Summary: 1 STORE, 1 SKIP, 0 REVIEW');
  });
});

describe('knowledge-mine: store mode', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
  });

  it('dry_run=false stores STORE candidates', async () => {
    const output = await handleMine({ project: 'test-project',
      dry_run: false,
      candidates: [makeCandidate({ title: 'Stored Mining Candidate', summary: 'Unique stored mining candidate summary' })],
    }, ctx.engine, null, ctx.config);

    const results = ctx.engine.search('Stored Mining Candidate', { limit: 10 });

    expect(output).toContain('⮕ STORE — No similar notes found');
    expect(output).toContain('✅ Stored as');
    expect(results.some(note => note.title === 'Stored Mining Candidate')).toBe(true);
  });

  it('stores mined notes with the supplied client applicability', async () => {
    await handleMine({
      project: 'test-project', client: 'pi', dry_run: false,
      candidates: [makeCandidate({ title: 'Pi Scoped Mining Note', summary: 'Unique Pi scoped mining note' })],
    }, ctx.engine, null, ctx.config);

    const stored = ctx.engine.search('Pi Scoped Mining Note', {
      kind: 'observation', visibility: { project: 'test-project', client: 'pi' },
    })[0];
    expect(stored.tags).toContain('project:test-project');
    expect(stored.tags).toContain('client:pi');
    expect(ctx.engine.search('Pi Scoped Mining Note', {
      kind: 'observation', visibility: { project: 'test-project', client: 'cursor' },
    })).toEqual([]);
  });

  it('extracts the real stored id when a mined title contains an arrow', async () => {
    const output = await handleMine({ project: 'test-project',
      dry_run: false,
      candidates: [makeCandidate({ title: 'Cause → Effect Mapping', summary: 'Unique arrow-title mining candidate summary' })],
    }, ctx.engine, null, ctx.config);

    const results = ctx.engine.search('Cause Effect Mapping', { limit: 10 });
    const stored = results.find(note => note.title === 'Cause → Effect Mapping');
    expect(stored).toBeDefined();

    // Reported id must be the real 16-digit note id, not the "Effect" token after the title's arrow.
    expect(stored!.id).toMatch(/^\d{16}$/);
    expect(output).toContain(`✅ Stored as ${stored!.id}`);
    expect(output).not.toContain('✅ Stored as Effect');
  });

  it('dry_run=false skips SKIP candidates', async () => {
    await handleStore({ project: 'test-project',
      title: 'Existing Duplicate Seed',
      content: 'Do not duplicate this already captured note.',
      kind: 'observation',
      summary: 'Do not duplicate this already captured note',
      guidance: 'Prefer the existing duplicate seed.',
    }, ctx.engine, null, ctx.config);

    await handleMine({ project: 'test-project',
      dry_run: false,
      candidates: [makeCandidate({
        title: 'New Duplicate Candidate',
        content: 'Do not duplicate this already captured note again.',
        summary: 'Do not duplicate this already captured note',
        guidance: 'This should not be stored.',
      })],
    }, ctx.engine, null, ctx.config);

    const results = ctx.engine.search('New Duplicate Candidate', { limit: 10 });

    expect(results.some(note => note.title === 'New Duplicate Candidate')).toBe(false);
  });

  it('source tag stored as mined:{source}', async () => {
    await handleMine({ project: 'test-project',
      dry_run: false,
      candidates: [makeCandidate({
        title: 'Mined Source Candidate',
        summary: 'Unique mined source candidate summary',
        source: 'ses_abc123',
      })],
    }, ctx.engine, null, ctx.config);

    const note = ctx.engine.search('Mined Source Candidate', { limit: 10 })
      .find(result => result.title === 'Mined Source Candidate');

    expect(note).toBeDefined();
    expect(note?.tags).toContain('mined:ses_abc123');
  });

  it('project tag applied to all candidates', async () => {
    await handleMine({
      dry_run: false,
      project: 'myapp',
      candidates: [
        makeCandidate({ title: 'Project Candidate One', summary: 'Unique project candidate one summary' }),
        makeCandidate({ title: 'Project Candidate Two', summary: 'Unique project candidate two summary' }),
      ],
    }, ctx.engine, null, ctx.config);

    const first = ctx.engine.search('Project Candidate One', { limit: 10 })
      .find(result => result.title === 'Project Candidate One');
    const second = ctx.engine.search('Project Candidate Two', { limit: 10 })
      .find(result => result.title === 'Project Candidate Two');

    expect(first?.tags).toContain('project:myapp');
    expect(second?.tags).toContain('project:myapp');
  });

  it('fails closed for mixed-project batches', async () => {
    const output = await handleMine({
      project: 'fallback',
      dry_run: false,
      candidates: [
        makeCandidate({ title: 'Alpha Mixed Candidate', project: 'alpha' }),
        makeCandidate({ title: 'Beta Mixed Candidate', project: 'beta' }),
      ],
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('candidate project conflicts with project:fallback');
    expect(ctx.engine.search('Mixed Candidate', { limit: 10 })).toHaveLength(0);
  });

  it('commits mined stores through the path-scoped versioning flow', async () => {
    const vaultPath = ctx.tempDir;
    const versioning = new GitVersioning(vaultPath, { enabled: true, debounceMs: 10 });
    await versioning.init();

    try {
      const output = await handleMine({ project: 'test-project',
        dry_run: false,
        candidates: [makeCandidate({
          title: 'Versioned Mining Candidate',
          summary: 'Unique candidate stored through versioned mining',
        })],
      }, ctx.engine, null, ctx.config, versioning);

      const stored = ctx.engine.search('Versioned Mining Candidate', { limit: 10 })
        .find(note => note.title === 'Versioned Mining Candidate');
      expect(output).toContain(`✅ Stored as ${stored?.id}`);
      expect(stored).toBeDefined();

      let commitMessage = '';
      for (let attempt = 0; attempt < 20; attempt++) {
        const result = Bun.spawnSync(['git', 'log', '-1', '--format=%B'], { cwd: vaultPath });
        expect(result.exitCode).toBe(0);
        commitMessage = result.stdout.toString();
        if (commitMessage.includes('Store observation: "Versioned Mining Candidate"')) break;
        await Bun.sleep(25);
      }

      expect(commitMessage).toContain('Store observation: "Versioned Mining Candidate"');
      const status = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: vaultPath });
      expect(status.exitCode).toBe(0);
      expect(status.stdout.toString()).toBe('');
    } finally {
      versioning.shutdownSync();
    }
  });
});

describe('knowledge-mine: output format', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
  });

  it('includes summary line with counts', async () => {
    const output = await handleMine({ project: 'test-project', candidates: [makeCandidate()] }, ctx.engine, null, ctx.config);

    expect(output).toContain('Summary: 1 STORE, 0 SKIP, 0 REVIEW');
  });

  it('dry-run shows store instruction', async () => {
    const output = await handleMine({ project: 'test-project', candidates: [makeCandidate()] }, ctx.engine, null, ctx.config);

    expect(output).toContain('call again with project="test-project" and dry_run=false');
  });

  it('store mode omits dry-run instruction', async () => {
    const output = await handleMine({ project: 'test-project',
      dry_run: false,
      candidates: [makeCandidate({ title: 'Instruction Omitted Candidate', summary: 'Instruction omitted candidate summary' })],
    }, ctx.engine, null, ctx.config);

    expect(output).not.toContain('call again with project="test-project" and dry_run=false');
  });

  it('shows embeddings disabled warning when no embedding config', async () => {
    const output = await handleMine({ project: 'test-project', candidates: [makeCandidate()] }, ctx.engine, null, ctx.config);

    expect(output).toContain('Embeddings disabled');
    expect(output).toContain('SimHash + FTS5 only');
  });

  it('word count warning for oversized notes', async () => {
    const content = Array.from({ length: 401 }, (_, index) => `word${index}`).join(' ');
    const output = await handleMine({ project: 'test-project',
      candidates: [makeCandidate({
        title: 'Oversized Mining Candidate',
        content,
        summary: 'Oversized note needs splitting',
      })],
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('Words: 401 (oversized, target: ~100)');
    expect(output).toContain('oversized');
  });
});
