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

describe('knowledge-mine: reviewed apply mode', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => cleanupTestHarness(ctx));

  function keys(output: string): string[] {
    return [...output.matchAll(/Candidate key: ([a-f0-9]{64})/g)].map(match => match[1]);
  }

  function json(output: string): Record<string, unknown> {
    return JSON.parse(output) as Record<string, unknown>;
  }

  async function apply(candidates: MineCandidate[], dispositions: Array<{ candidateKey: string; action: 'store' | 'update' | 'skip'; noteId?: string; expectedUpdatedAt?: number }>, client?: string) {
    const planOutput = await handleMine({ project: 'test-project', client, candidates, dispositions }, ctx.engine, null, ctx.config);
    if (!planOutput.startsWith('{')) throw new Error(planOutput);
    const plan = json(planOutput);
    expect(plan.state).toBe('plan-ready');
    return handleMine({
      project: 'test-project', client, candidates, dispositions, dry_run: false, confirm: true,
      batchToken: plan.batchToken as string,
    }, ctx.engine, null, ctx.config);
  }

  it('makes legacy dry_run=false a zero-mutation migration response', async () => {
    const output = json(await handleMine({ project: 'test-project', dry_run: false, candidates: [makeCandidate()] }, ctx.engine, null, ctx.config));
    expect(output.state).toBe('migration-required');
    expect(output.mutated).toBe(false);
    expect(ctx.engine.getStats().total).toBe(0);
  });

  it('previews a complete candidate-keyed plan without mutation', async () => {
    const candidates = [makeCandidate({ title: 'Plan Candidate' })];
    const candidateKeys = keys(await handleMine({ project: 'test-project', candidates }, ctx.engine, null, ctx.config));
    const before = ctx.engine.getStats();
    const plan = json(await handleMine({
      project: 'test-project', candidates,
      dispositions: [{ candidateKey: candidateKeys[0], action: 'store' }],
    }, ctx.engine, null, ctx.config));
    expect(plan.state).toBe('plan-ready');
    expect(plan.batchToken).toBeString();
    expect((plan.plan as Array<{ token?: string }>)[0].token).toBeString();
    expect(ctx.engine.getStats()).toEqual(before);
  });

  it('keeps reviewed disposition identity stable across object member insertion order', async () => {
    const candidates = [makeCandidate({ title: 'Canonical Disposition' })];
    const candidateKey = keys(await handleMine({ project: 'test-project', candidates }, ctx.engine, null, ctx.config))[0];
    const previewDispositions = [{ candidateKey, action: 'store' as const }];
    const plan = json(await handleMine({ project: 'test-project', candidates, dispositions: previewDispositions }, ctx.engine, null, ctx.config));
    const applyDispositions = [{ action: 'store' as const, candidateKey }];
    const applied = await handleMine({
      project: 'test-project', candidates, dispositions: applyDispositions, dry_run: false, confirm: true,
      batchToken: plan.batchToken as string,
    }, ctx.engine, null, ctx.config);

    expect(applied).toContain('✅ Stored as');
    expect(ctx.engine.search('Canonical Disposition').some(note => note.title === 'Canonical Disposition')).toBe(true);
  });

  it('keeps reviewed candidate identity stable across object member insertion order', async () => {
    const candidate = makeCandidate({
      title: 'Canonical Candidate',
      content: 'Canonical candidate content',
      kind: 'procedure',
      summary: 'Canonical candidate summary',
      guidance: 'Use the canonical candidate.',
      project: 'test-project',
      tags: ['alpha', 'beta'],
      source: 'ses_canonical',
    });
    const reordered: MineCandidate = {
      source: candidate.source,
      tags: ['beta', 'alpha', 'alpha'],
      project: candidate.project,
      guidance: candidate.guidance,
      summary: candidate.summary,
      kind: candidate.kind,
      content: candidate.content,
      title: candidate.title,
    };
    const candidateKey = keys(await handleMine({ project: 'test-project', candidates: [candidate] }, ctx.engine, null, ctx.config))[0];
    const dispositions = [{ candidateKey, action: 'store' as const }];
    const plan = json(await handleMine({ project: 'test-project', candidates: [candidate], dispositions }, ctx.engine, null, ctx.config));
    const applied = await handleMine({
      project: 'test-project', candidates: [reordered], dispositions, dry_run: false, confirm: true, batchToken: plan.batchToken as string,
    }, ctx.engine, null, ctx.config);

    expect(applied).toContain('✅ Stored as');
    expect(ctx.engine.search('Canonical Candidate').some(note => note.title === 'Canonical Candidate')).toBe(true);

    for (const changed of [
      { ...candidate, content: 'Changed canonical candidate content' },
      { ...candidate, tags: [...(candidate.tags ?? []), 'gamma'] },
    ]) {
      const changedKey = keys(await handleMine({ project: 'test-project', candidates: [changed] }, ctx.engine, null, ctx.config))[0];
      const stale = json(await handleMine({
        project: 'test-project', candidates: [changed], dispositions: [{ candidateKey: changedKey, action: 'skip' }],
        dry_run: false, confirm: true, batchToken: plan.batchToken as string,
      }, ctx.engine, null, ctx.config));
      expect(stale.state).toBe('stale-plan');
    }
  });

  it('stores, skips, and leaves unspecified candidates unchanged in original order', async () => {
    const candidates = [
      makeCandidate({ title: 'Stored Mining Candidate', summary: 'Unique stored candidate', source: 'ses_abc123' }),
      makeCandidate({ title: 'Skipped Mining Candidate', summary: 'Unique skipped candidate' }),
      makeCandidate({ title: 'Unspecified Mining Candidate', summary: 'Unique unspecified candidate' }),
    ];
    const candidateKeys = keys(await handleMine({ project: 'test-project', client: 'pi', candidates }, ctx.engine, null, ctx.config));
    const output = await apply(candidates, [
      { candidateKey: candidateKeys[0], action: 'store' },
      { candidateKey: candidateKeys[1], action: 'skip' },
    ], 'pi');
    expect(output).toContain('✅ Stored as');
    const stored = ctx.engine.search('Stored Mining Candidate', { visibility: { project: 'test-project', client: 'pi' } })[0];
    expect(stored.tags).toContain('project:test-project');
    expect(stored.tags).toContain('client:pi');
    expect(stored.tags).toContain('mined:ses_abc123');
    expect(ctx.engine.search('Skipped Mining Candidate').some(note => note.title === 'Skipped Mining Candidate')).toBe(false);
    expect(ctx.engine.search('Unspecified Mining Candidate').some(note => note.title === 'Unspecified Mining Candidate')).toBe(false);
  });

  it('applies a reviewed update to the selected visible target', async () => {
    const stored = await handleStore({ project: 'test-project', title: 'Update Target', content: 'old content', kind: 'reference', summary: 'Old summary', guidance: 'Use old content.' }, ctx.engine, null, ctx.config);
    const id = /→\s*(\d{16})/.exec(stored)?.[1];
    if (!id) throw new Error('Expected target id');
    const target = ctx.engine.getById(id);
    if (!target) throw new Error('Expected target');
    const candidates = [makeCandidate({ title: 'Update Target', content: 'new durable content', kind: 'reference', summary: 'New summary', guidance: 'Use new content.' })];
    const candidateKeys = keys(await handleMine({ project: 'test-project', candidates }, ctx.engine, null, ctx.config));
    const output = await apply(candidates, [{ candidateKey: candidateKeys[0], action: 'update', noteId: id, expectedUpdatedAt: target.updated_at }]);
    expect(output).toContain(`✅ Stored as ${id}`);
    expect(ctx.engine.getById(id)?.content).toBe('new durable content');
  });

  it('rejects stale, malformed, reordered, and conflicting plans without mutation', async () => {
    const candidates = [makeCandidate({ title: 'First Plan Item' }), makeCandidate({ title: 'Second Plan Item' })];
    const candidateKeys = keys(await handleMine({ project: 'test-project', candidates }, ctx.engine, null, ctx.config));
    const dispositions = [{ candidateKey: candidateKeys[0], action: 'store' as const }];
    const plan = json(await handleMine({ project: 'test-project', candidates, dispositions }, ctx.engine, null, ctx.config));
    await handleStore({ project: 'test-project', title: 'Unrelated Evidence Mutation', content: 'completely unrelated intervening content', kind: 'observation', summary: 'Unrelated intervening summary', guidance: 'Keep unrelated evidence.' }, ctx.engine, null, ctx.config);
    const stale = json(await handleMine({ project: 'test-project', candidates, dispositions, dry_run: false, confirm: true, batchToken: plan.batchToken as string }, ctx.engine, null, ctx.config));
    expect(stale.state).toBe('stale-plan');
    expect(ctx.engine.search('First Plan Item').filter(note => note.title === 'First Plan Item')).toHaveLength(0);

    const reordered = await handleMine({ project: 'test-project', candidates: [...candidates].reverse(), dispositions }, ctx.engine, null, ctx.config);
    expect(reordered).toContain('duplicate or unknown candidate keys');
    const edited = await handleMine({ project: 'test-project', candidates: [makeCandidate({ title: 'First Plan Item', content: 'edited after preview' }), candidates[1]], dispositions }, ctx.engine, null, ctx.config);
    expect(edited).toContain('duplicate or unknown candidate keys');
    const duplicateKey = await handleMine({ project: 'test-project', candidates, dispositions: [dispositions[0], dispositions[0]] }, ctx.engine, null, ctx.config);
    expect(duplicateKey).toContain('duplicate or unknown candidate keys');

    const target = ctx.engine.search('Unrelated Evidence Mutation').find(note => note.title === 'Unrelated Evidence Mutation');
    if (!target) throw new Error('Expected conflict target');
    const conflicting = await handleMine({ project: 'test-project', candidates, dispositions: [
      { candidateKey: candidateKeys[0], action: 'update', noteId: target.id, expectedUpdatedAt: target.updated_at },
      { candidateKey: candidateKeys[1], action: 'update', noteId: target.id, expectedUpdatedAt: target.updated_at },
    ] }, ctx.engine, null, ctx.config);
    expect(conflicting).toContain('conflicting updates');
  });

  it('leaves REVIEW and hidden update targets unchanged when not safely authorized', async () => {
    await handleStore({ project: 'test-project', title: 'Release Checklist', content: 'Run build and release checks.', kind: 'procedure', summary: 'Release checklist for build verification', guidance: 'Use before release.' }, ctx.engine, null, ctx.config);
    const candidates = [
      makeCandidate({ title: 'Release Checklist Followup', content: 'Assign rollback ownership.', kind: 'procedure', summary: 'Rollback ownership after release incident', guidance: 'Assign followup ownership.' }),
      makeCandidate({ title: 'Authorized Unique Candidate', summary: 'Authorized unique candidate summary.' }),
    ];
    const initial = await handleMine({ project: 'test-project', candidates }, ctx.engine, null, ctx.config);
    expect(initial).toContain('⮕ REVIEW');
    const candidateKeys = keys(initial);
    await apply(candidates, [{ candidateKey: candidateKeys[1], action: 'store' }]);
    expect(ctx.engine.search('Release Checklist Followup').some(note => note.title === 'Release Checklist Followup')).toBe(false);

    const hidden = await handleStore({ project: 'test-project', client: 'cursor', title: 'Hidden Mine Target', content: 'hidden target content', kind: 'reference', summary: 'Hidden mine target summary.', guidance: 'Keep hidden.' }, ctx.engine, null, ctx.config);
    const hiddenId = /→\s*(\d{16})/.exec(hidden)?.[1];
    if (!hiddenId) throw new Error('Expected hidden target ID');
    const hiddenTarget = ctx.engine.getById(hiddenId);
    if (!hiddenTarget) throw new Error('Expected hidden target');
    const updateCandidates = [makeCandidate({ title: 'Hidden Mine Target', content: 'attempted hidden update', kind: 'reference' })];
    const updateKeys = keys(await handleMine({ project: 'test-project', client: 'pi', candidates: updateCandidates }, ctx.engine, null, ctx.config));
    const plan = await handleMine({ project: 'test-project', client: 'pi', candidates: updateCandidates, dispositions: [{ candidateKey: updateKeys[0], action: 'update', noteId: hiddenId, expectedUpdatedAt: hiddenTarget.updated_at }] }, ctx.engine, null, ctx.config);
    expect(plan).toContain('not active and visible');
    expect(ctx.engine.getById(hiddenId)?.content).toBe('hidden target content');
  });

  it('reports the completed prefix when a later accepted operation fails', async () => {
    const candidates = [
      makeCandidate({ title: 'First Domain Candidate', kind: 'domain', content: 'first domain content', summary: 'First domain summary.' }),
      makeCandidate({ title: 'Second Domain Candidate', kind: 'domain', content: 'second domain content', summary: 'Second domain summary.' }),
    ];
    const candidateKeys = keys(await handleMine({ project: 'test-project', candidates }, ctx.engine, null, ctx.config));
    const dispositions = candidateKeys.map(candidateKey => ({ candidateKey, action: 'store' as const }));
    const plan = json(await handleMine({ project: 'test-project', candidates, dispositions }, ctx.engine, null, ctx.config));
    const result = json(await handleMine({
      project: 'test-project', candidates, dispositions, dry_run: false, confirm: true, batchToken: plan.batchToken as string,
    }, ctx.engine, null, ctx.config));
    expect(result.state).toBe('partial-failure');
    expect(result.mutated).toBe(true);
    expect(result.completed).toHaveLength(1);
    expect(result.message).toContain('not rolled back');
    expect(ctx.engine.getScreeningSnapshot({ project: 'test-project' }).notes.filter(note => note.kind === 'domain')).toHaveLength(1);
  });

  it('permits two explicitly reviewed duplicate-looking creates in one batch', async () => {
    const candidates = [
      makeCandidate({ title: 'Duplicate Explicit A', content: 'same durable duplicate content', summary: 'Same durable duplicate summary' }),
      makeCandidate({ title: 'Duplicate Explicit B', content: 'same durable duplicate content', summary: 'Same durable duplicate summary' }),
    ];
    const candidateKeys = keys(await handleMine({ project: 'test-project', candidates }, ctx.engine, null, ctx.config));
    await apply(candidates, candidateKeys.map(candidateKey => ({ candidateKey, action: 'store' as const })));
    expect(ctx.engine.search('Duplicate Explicit').filter(note => note.title.startsWith('Duplicate Explicit'))).toHaveLength(2);
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

  it('dry-run shows the reviewed-plan instruction and candidate identity', async () => {
    const output = await handleMine({ project: 'test-project', candidates: [makeCandidate()] }, ctx.engine, null, ctx.config);

    expect(output).toContain('To prepare a reviewed plan');
    expect(output).toMatch(/Candidate key: [a-f0-9]{64}/);
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
