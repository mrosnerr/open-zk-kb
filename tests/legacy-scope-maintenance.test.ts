import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'fs';
import { handleMaintain } from '../src/tool-handlers.js';
import { cleanupTestHarness, createTestHarness, type TestContext } from './harness.js';

describe('legacy scope maintenance', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => cleanupTestHarness(ctx));

  it('inventories deterministic applicability evidence without mutation and reports strict readiness', async () => {
    const legacy = ctx.engine.store('Legacy body.', { title: 'Legacy', kind: 'reference', tags: [] });
    const before = fs.readFileSync(legacy.path, 'utf8');
    const report = JSON.parse(await handleMaintain({ action: 'scope-inventory' }, ctx.engine, ctx.config));
    expect(report).toMatchObject({ mutated: false, strictVisibility: { active: true, mode: 'fail-closed', unclassifiedExcluded: true }, counts: { activeUnclassified: 1, ready: false } });
    expect(JSON.stringify(report.groups)).toContain(legacy.id);
    expect(fs.readFileSync(legacy.path, 'utf8')).toBe(before);
    expect(ctx.engine.search('Legacy', { visibility: { project: 'alpha' } })).toHaveLength(0);
  });

  it('requires confirmation then assigns, repairs path, tags, FTS, and visibility', async () => {
    const legacy = ctx.engine.store('Repair keyword.', { title: 'Needs Repair', kind: 'reference', tags: ['project:old', 'project:other', 'scope:global', 'topic'] });
    expect(await handleMaintain({ action: 'assign-project', noteId: legacy.id, project: 'alpha', dryRun: false }, ctx.engine, ctx.config)).toContain('confirm=true');
    const preview = JSON.parse(await handleMaintain({ action: 'assign-project', noteId: legacy.id, project: 'alpha', dryRun: true }, ctx.engine, ctx.config));
    const result = JSON.parse(await handleMaintain({ action: 'assign-project', noteId: legacy.id, project: 'alpha', dryRun: false, confirm: true, token: preview.confirmationToken }, ctx.engine, ctx.config));
    const assigned = ctx.engine.getById(legacy.id);
    expect(assigned).not.toBeNull();
    if (!assigned) throw new Error('assigned note missing');
    expect(result.mutated).toBe(true);
    expect(assigned.tags).toEqual(['topic', 'project:alpha']);
    expect(assigned.path).toContain('/projects/alpha/references/');
    expect(fs.existsSync(legacy.path)).toBe(false);
    expect(ctx.engine.search('Repair', { visibility: { project: 'alpha' } }).map(note => note.id)).toContain(legacy.id);
    await handleMaintain({ action: 'rebuild' }, ctx.engine, ctx.config);
    expect(ctx.engine.getById(legacy.id)?.path).toBe(assigned.path);
  });

  it('leaves note bytes and indexed metadata unchanged when the filesystem move fails', async () => {
    const legacy = ctx.engine.store('Original bytes.', { title: 'Failed Assignment', kind: 'reference', tags: ['topic'] });
    const beforeFile = fs.readFileSync(legacy.path, 'utf8');
    const beforeNote = ctx.engine.getById(legacy.id);
    const preview = JSON.parse(await handleMaintain({ action: 'assign-project', noteId: legacy.id, project: 'alpha', dryRun: true }, ctx.engine, ctx.config));
    const rename = spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('forced rename failure'); });
    try {
      const result = await handleMaintain({ action: 'assign-project', noteId: legacy.id, project: 'alpha', dryRun: false, confirm: true, token: preview.confirmationToken }, ctx.engine, ctx.config);
      expect(result).toContain('assignment failed');
    } finally {
      rename.mockRestore();
    }

    expect(fs.readFileSync(legacy.path, 'utf8')).toBe(beforeFile);
    expect(ctx.engine.getById(legacy.id)).toMatchObject({
      path: beforeNote?.path,
      tags: beforeNote?.tags,
      updated_at: beforeNote?.updated_at,
    });
    expect(ctx.engine.search('Original', { visibility: { project: 'alpha' } })).toHaveLength(0);
  });

  it('rejects stale assignment confirmations', async () => {
    const legacy = ctx.engine.store('Original body.', { title: 'Stale Assignment', kind: 'reference', tags: [] });
    const preview = JSON.parse(await handleMaintain({ action: 'assign-project', noteId: legacy.id, project: 'alpha', dryRun: true }, ctx.engine, ctx.config));
    ctx.engine.store('Changed body.', { title: 'Stale Assignment', kind: 'reference', tags: [], existingId: legacy.id });
    const result = await handleMaintain({ action: 'assign-project', noteId: legacy.id, project: 'alpha', dryRun: false, confirm: true, token: preview.confirmationToken }, ctx.engine, ctx.config);
    expect(result).toContain('stale or does not match');
    expect(ctx.engine.getById(legacy.id)?.tags).toEqual([]);
  });

  it('keeps assigned personalizations in the canonical preferences path', async () => {
    const preference = ctx.engine.store('Use concise prose.', { title: 'Concise', kind: 'personalization', tags: [] });
    const preview = JSON.parse(await handleMaintain({ action: 'assign-project', noteId: preference.id, project: 'alpha', dryRun: true }, ctx.engine, ctx.config));
    await handleMaintain({ action: 'assign-project', noteId: preference.id, project: 'alpha', dryRun: false, confirm: true, token: preview.confirmationToken }, ctx.engine, ctx.config);
    const assigned = ctx.engine.getById(preference.id);
    expect(assigned).not.toBeNull();
    if (!assigned) throw new Error('assigned preference missing');
    expect(assigned.tags).toEqual(['project:alpha']);
    expect(assigned.path).toContain('/preferences/');
    expect(assigned.tags).not.toContain('scope:global');
  });
});
