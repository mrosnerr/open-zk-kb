import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createTestHarness, cleanupTestHarness } from './harness.js';
import type { TestContext } from './harness.js';
import { handleMine, handleStore } from '../src/tool-handlers.js';
import type { MineCandidate } from '../src/tool-handlers.js';

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
    const output = await handleMine({ candidates: [] }, ctx.engine, null, ctx.config);

    expect(output).toContain('No mining candidates provided');
    expect(output).toContain('at least one candidate');
    expect(output).not.toContain('Error:');
  });

  it('over 50 candidates', async () => {
    const candidates = Array.from({ length: 51 }, (_, index) => makeCandidate({ title: `Candidate ${index}` }));

    const output = await handleMine({ candidates }, ctx.engine, null, ctx.config);

    expect(output).toContain('Error: knowledge-mine accepts at most 50 candidates per batch');
    expect(output).toContain('received 51');
  });

  it('missing required field (title)', async () => {
    const output = await handleMine({ candidates: [makeCandidate({ title: '' })] }, ctx.engine, null, ctx.config);

    expect(output).toContain('Error: Candidate 1');
    expect(output).toContain('missing required field "title"');
  });

  it('missing required field (summary)', async () => {
    const output = await handleMine({ candidates: [makeCandidate({ summary: '   ' })] }, ctx.engine, null, ctx.config);

    expect(output).toContain('Error: Candidate 1');
    expect(output).toContain('missing required field "summary"');
  });

  it('structural kind (index)', async () => {
    const output = await handleMine({ candidates: [makeCandidate({ kind: 'index' })] }, ctx.engine, null, ctx.config);

    expect(output).toContain('Error: Candidate 1');
    expect(output).toContain('index notes are structural and auto-generated');
  });

  it('structural kind (log)', async () => {
    const output = await handleMine({ candidates: [makeCandidate({ kind: 'log' })] }, ctx.engine, null, ctx.config);

    expect(output).toContain('Error: Candidate 1');
    expect(output).toContain('log notes are structural and auto-generated');
  });

  it('domain kind without project', async () => {
    const output = await handleMine({ candidates: [makeCandidate({ kind: 'domain' })] }, ctx.engine, null, ctx.config);

    expect(output).toContain('Error: Candidate 1');
    expect(output).toContain('domain notes require a project parameter');
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
    const output = await handleMine({ candidates: [makeCandidate()] }, ctx.engine, null, ctx.config);

    expect(output).toContain('⮕ STORE — No similar notes found');
    expect(output).not.toContain('↳ [');
    expect(output).toContain('Summary: 1 STORE, 0 SKIP, 0 REVIEW');
  });

  it('dry_run defaults to true', async () => {
    await handleMine({ candidates: [makeCandidate({ title: 'Default Dry Run Note' })] }, ctx.engine, null, ctx.config);

    const stats = ctx.engine.getStats();
    const results = ctx.engine.search('Default Dry Run Note', { limit: 10 });

    expect(stats.total).toBe(0);
    expect(results).toHaveLength(0);
  });

  it('candidate matching existing note', async () => {
    await handleStore({
      title: 'Session Context Capture',
      content: 'Capture durable session context before ending work.',
      kind: 'observation',
      summary: 'Capture durable session context before ending work',
      guidance: 'Store durable session context before handoff.',
    }, ctx.engine, null, ctx.config);

    const output = await handleMine({
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

  it('candidate partially matching existing note', async () => {
    await handleStore({
      title: 'Release Checklist',
      content: 'Run build, tests, and changelog checks before release.',
      kind: 'procedure',
      summary: 'Release checklist for build verification',
      guidance: 'Use this before publishing releases.',
    }, ctx.engine, null, ctx.config);

    const output = await handleMine({
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
    const output = await handleMine({
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
    const output = await handleMine({
      dry_run: false,
      candidates: [makeCandidate({ title: 'Stored Mining Candidate', summary: 'Unique stored mining candidate summary' })],
    }, ctx.engine, null, ctx.config);

    const results = ctx.engine.search('Stored Mining Candidate', { limit: 10 });

    expect(output).toContain('⮕ STORE — No similar notes found');
    expect(output).toContain('✅ Stored as');
    expect(results.some(note => note.title === 'Stored Mining Candidate')).toBe(true);
  });

  it('dry_run=false skips SKIP candidates', async () => {
    await handleStore({
      title: 'Existing Duplicate Seed',
      content: 'Do not duplicate this already captured note.',
      kind: 'observation',
      summary: 'Do not duplicate this already captured note',
      guidance: 'Prefer the existing duplicate seed.',
    }, ctx.engine, null, ctx.config);

    await handleMine({
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
    await handleMine({
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
    const output = await handleMine({ candidates: [makeCandidate()] }, ctx.engine, null, ctx.config);

    expect(output).toContain('Summary: 1 STORE, 0 SKIP, 0 REVIEW');
  });

  it('dry-run shows store instruction', async () => {
    const output = await handleMine({ candidates: [makeCandidate()] }, ctx.engine, null, ctx.config);

    expect(output).toContain('call again with dry_run=false');
  });

  it('store mode omits dry-run instruction', async () => {
    const output = await handleMine({
      dry_run: false,
      candidates: [makeCandidate({ title: 'Instruction Omitted Candidate', summary: 'Instruction omitted candidate summary' })],
    }, ctx.engine, null, ctx.config);

    expect(output).not.toContain('call again with dry_run=false');
  });

  it('shows embeddings disabled warning when no embedding config', async () => {
    const output = await handleMine({ candidates: [makeCandidate()] }, ctx.engine, null, ctx.config);

    expect(output).toContain('Embeddings disabled');
    expect(output).toContain('SimHash + FTS5 only');
  });

  it('word count warning for oversized notes', async () => {
    const content = Array.from({ length: 401 }, (_, index) => `word${index}`).join(' ');
    const output = await handleMine({
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
