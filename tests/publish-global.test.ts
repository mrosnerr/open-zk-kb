import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { handleMaintain, type PublishGlobalCandidate } from '../src/tool-handlers.js';
import { cleanupTestHarness, createTestHarness, type TestContext } from './harness.js';

const candidate: PublishGlobalCandidate = {
  title: 'Prefer Deterministic Tokens',
  content: 'Canonical inputs make confirmation reproducible.',
  kind: 'reference',
  summary: 'Canonical inputs produce stable confirmation tokens.',
  guidance: 'Canonicalize inputs before generating confirmation tokens.',
  tags: ['security'],
};

describe('publish-global maintenance', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => cleanupTestHarness(ctx));

  function source(lifecycle: 'living' | 'snapshot' = 'living') {
    return ctx.engine.store('Project-only source body.', {
      title: 'Local Source', kind: 'observation', status: 'permanent', lifecycle,
      tags: ['project:alpha', 'client:pi'], summary: 'Local summary', guidance: 'Keep local guidance.',
    });
  }

  it('previews deterministically without mutation and reports evidence', async () => {
    const local = source();
    const before = fs.readFileSync(local.path, 'utf8');
    const first = await handleMaintain({ action: 'publish-global', noteId: local.id, candidate, dryRun: true }, ctx.engine, ctx.config);
    const second = await handleMaintain({ action: 'publish-global', noteId: local.id, candidate, dryRun: true }, ctx.engine, ctx.config);
    expect(first).toBe(second);
    expect(JSON.parse(first)).toMatchObject({ valid: true, duplicates: [], projectReferences: [], outboundLinks: [] });
    expect(fs.readFileSync(local.path, 'utf8')).toBe(before);
    expect(ctx.engine.getAllGlobalNotes()).toHaveLength(0);
  });

  it('requires confirmation and rejects mismatched or stale tokens', async () => {
    const local = source();
    const preview = JSON.parse(await handleMaintain({ action: 'publish-global', noteId: local.id, candidate, dryRun: true }, ctx.engine, ctx.config));
    expect(await handleMaintain({ action: 'publish-global', noteId: local.id, candidate, dryRun: false, token: preview.confirmationToken }, ctx.engine, ctx.config)).toContain('confirm=true');
    expect(await handleMaintain({ action: 'publish-global', noteId: local.id, candidate: { ...candidate, title: 'Different Candidate' }, dryRun: false, confirm: true, token: preview.confirmationToken }, ctx.engine, ctx.config)).toContain('stale or does not match');
    ctx.engine.store('Changed source.', { existingId: local.id, title: 'Local Source', kind: 'observation', tags: ['project:alpha', 'client:pi'] });
    expect(await handleMaintain({ action: 'publish-global', noteId: local.id, candidate, dryRun: false, confirm: true, token: preview.confirmationToken }, ctx.engine, ctx.config)).toContain('stale or does not match');
  });

  it('creates a separate derivative and preserves source semantics', async () => {
    const local = source();
    ctx.engine.store('Legacy hidden body.', { title: 'Legacy Hidden Note', kind: 'reference', tags: [] });
    const before = ctx.engine.getById(local.id)!;
    const preview = JSON.parse(await handleMaintain({ action: 'publish-global', noteId: local.id, candidate, dryRun: true }, ctx.engine, ctx.config));
    await handleMaintain({ action: 'publish-global', noteId: local.id, candidate, dryRun: false, confirm: true, token: preview.confirmationToken }, ctx.engine, ctx.config);
    const after = ctx.engine.getById(local.id)!;
    expect({ title: after.title, content: after.content, summary: after.summary, guidance: after.guidance, tags: after.tags, lifecycle: after.lifecycle, status: after.status })
      .toEqual({ title: before.title, content: before.content, summary: before.summary, guidance: before.guidance, tags: before.tags, lifecycle: before.lifecycle, status: before.status });
    const global = ctx.engine.getAllGlobalNotes()[0];
    expect(global.tags).toEqual(['security', 'scope:global']);
    expect(fs.readFileSync(global.path, 'utf8')).not.toContain(local.id);
    expect(fs.readFileSync(global.path, 'utf8')).not.toContain('project:alpha');
    const generalIndex = fs.readFileSync(path.join(ctx.tempDir, 'general', 'general.md'), 'utf8');
    expect(generalIndex).toContain('includes("scope:global")');
    expect(generalIndex).not.toContain('obsidian://quickadd');
    expect(generalIndex).not.toContain('Legacy Hidden Note');
    expect(generalIndex).not.toContain(local.id);
    expect(generalIndex).not.toContain('project:alpha');
    expect(fs.existsSync(path.join(ctx.tempDir, 'log.md'))).toBe(false);
  });

  it('rejects exact project evidence and non-global links while allowing global links', async () => {
    const local = source();
    const otherLocal = ctx.engine.store('Private target.', {
      title: 'Alpha Secret', kind: 'reference', status: 'permanent', tags: ['project:alpha'],
      summary: 'Private.', guidance: 'Keep private.',
    });
    const global = ctx.engine.store('Reusable target.', {
      title: 'Reusable Target', kind: 'reference', status: 'permanent', tags: ['scope:global'],
      summary: 'Reusable.', guidance: 'Reuse.',
    });
    const accepted = JSON.parse(await handleMaintain({ action: 'publish-global', noteId: local.id, candidate: {
      ...candidate, content: `Use [[${global.id}|Reusable Target]].`,
    }, dryRun: true }, ctx.engine, ctx.config));
    expect(accepted.valid).toBe(true);
    const rejected = JSON.parse(await handleMaintain({ action: 'publish-global', noteId: local.id, candidate: {
      ...candidate,
      title: 'Alpha deployment',
      content: `See projects/alpha and [[${otherLocal.id}|Alpha Secret]] and [[missing-note]].`,
      tags: ['security', 'project:alpha'],
    }, dryRun: true }, ctx.engine, ctx.config));
    expect(rejected.valid).toBe(false);
    expect(rejected.projectReferences.join('\n')).toContain('project-name:alpha');
    expect(rejected.projectReferences.join('\n')).toContain('project-path:projects/alpha');
    expect(rejected.projectReferences).toContain('tag:project:alpha');
    expect(rejected.outboundLinks.join('\n')).toContain('project-local:');
    expect(rejected.outboundLinks).toContain('unresolved:[[missing-note]]');
  });

  it('validates links in every rendered field and rejects archived global targets', async () => {
    const local = source();
    const privateTarget = ctx.engine.store('Private target.', {
      title: 'Private Target', kind: 'reference', status: 'permanent', tags: ['project:alpha'],
      summary: 'Private.', guidance: 'Keep private.',
    });
    for (const field of ['title', 'summary', 'guidance'] as const) {
      const proposed = { ...candidate, [field]: `Use [[${privateTarget.id}|Private Target]].` };
      const preview = JSON.parse(await handleMaintain({
        action: 'publish-global', noteId: local.id, candidate: proposed, dryRun: true,
      }, ctx.engine, ctx.config));
      expect(preview.valid).toBe(false);
      expect(preview.outboundLinks.join('\n')).toContain(`${field}:project-local:`);
    }

    const archivedGlobal = ctx.engine.store('Inactive reusable target.', {
      title: 'Archived Global Target', kind: 'reference', status: 'permanent', tags: ['scope:global'],
      summary: 'Inactive.', guidance: 'Do not use.',
    });
    ctx.engine.archive(archivedGlobal.id);
    const archivedPreview = JSON.parse(await handleMaintain({
      action: 'publish-global', noteId: local.id,
      candidate: { ...candidate, content: `Use [[${archivedGlobal.id}|Archived Global Target]].` },
      dryRun: true,
    }, ctx.engine, ctx.config));
    expect(archivedPreview.valid).toBe(false);
    expect(archivedPreview.outboundLinks.join('\n')).toContain('archived:');
    expect(archivedPreview.errors.join('\n')).toContain('not active global');
  });

  it('does not revive a used confirmation token after rebuild', async () => {
    const local = source();
    ctx.engine.rebuildFromFiles();
    const preview = JSON.parse(await handleMaintain({
      action: 'publish-global', noteId: local.id, candidate, dryRun: true,
    }, ctx.engine, ctx.config));
    await handleMaintain({
      action: 'publish-global', noteId: local.id, candidate, dryRun: false,
      confirm: true, token: preview.confirmationToken,
    }, ctx.engine, ctx.config);
    ctx.engine.rebuildFromFiles();

    const replay = await handleMaintain({
      action: 'publish-global', noteId: local.id, candidate, dryRun: false,
      confirm: true, token: preview.confirmationToken,
    }, ctx.engine, ctx.config);
    expect(replay).toContain('stale or does not match');
  });

  it('audits global violations deterministically without mutation', async () => {
    const local = source();
    const global = ctx.engine.store(`References [[${local.id}|Local Source]].`, {
      title: 'Legacy Global', kind: 'reference', status: 'permanent', tags: ['scope:global'],
      summary: 'Legacy.', guidance: 'Review.',
    });
    const before = fs.readFileSync(global.path, 'utf8');
    const first = await handleMaintain({ action: 'global-reference-audit' }, ctx.engine, ctx.config);
    const second = await handleMaintain({ action: 'global-reference-audit' }, ctx.engine, ctx.config);
    expect(first).toBe(second);
    expect(JSON.parse(first)).toMatchObject({ mutated: false, scanned: 1, findings: [{ id: global.id }] });
    expect(first).toContain('project-local:');
    expect(ctx.engine.getOutgoingLinks(global.id)).toEqual([]);
    ctx.engine.rebuildFromFiles();
    expect(ctx.engine.getOutgoingLinks(global.id)).toEqual([]);
    expect(await handleMaintain({ action: 'global-reference-audit' }, ctx.engine, ctx.config)).toContain('project-local:');
    expect(fs.readFileSync(global.path, 'utf8')).toBe(before);
  });

  it('hides local incoming provenance from global backlink surfaces', () => {
    const local = source();
    const global = ctx.engine.store('Reusable.', {
      title: 'Global', kind: 'reference', status: 'permanent', tags: ['scope:global'], summary: 'Reusable.', guidance: 'Reuse.',
    });
    ctx.engine.addLocalToGlobalRelation(local.id, global.id);
    expect(ctx.engine.getOutgoingLinks(local.id).map(({ note }) => note.id)).toContain(global.id);
    expect(ctx.engine.getGlobalBacklinks(global.id)).toEqual([]);
  });

  it('adds and rebuilds the one-way relation on a snapshot source', async () => {
    const local = source('snapshot');
    const original = fs.readFileSync(local.path, 'utf8');
    const customized = original.replace('\n---\n\n', '\ncustom_field: preserve-verbatim\n---\n\n');
    fs.writeFileSync(local.path, customized, 'utf8');
    ctx.engine.rebuildFromFiles();
    const beforePublication = fs.readFileSync(local.path, 'utf8');
    const preview = JSON.parse(await handleMaintain({ action: 'publish-global', noteId: local.id, candidate, dryRun: true }, ctx.engine, ctx.config));
    await handleMaintain({ action: 'publish-global', noteId: local.id, candidate, dryRun: false, confirm: true, token: preview.confirmationToken }, ctx.engine, ctx.config);
    const publishedSource = fs.readFileSync(local.path, 'utf8');
    expect(publishedSource.startsWith(beforePublication)).toBe(true);
    expect(publishedSource).toContain('custom_field: preserve-verbatim');
    const global = ctx.engine.getAllGlobalNotes()[0];
    expect(ctx.engine.getOutgoingLinks(local.id).map(({ note }) => note.id)).toContain(global.id);
    expect(ctx.engine.getOutgoingLinks(global.id)).toHaveLength(0);
    ctx.engine.rebuildFromFiles();
    expect(ctx.engine.getOutgoingLinks(local.id).map(({ note }) => note.id)).toContain(global.id);
    expect(fs.readFileSync(ctx.engine.getLogNote('alpha')!.path, 'utf8')).toContain('Published global derivative');
  });
});
