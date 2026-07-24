import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { handleMaintain } from '../src/tool-handlers';
import { MAINTAIN_ACTIONS, TOOL_DEFINITIONS } from '../src/tool-meta';
import { cleanupTestHarness, createTestHarness, type TestContext } from './harness';

const DAY = 86_400_000;

function updateNote(ctx: TestContext, id: string, values: { createdAt?: number; updatedAt?: number }): void {
  const db = new Database(path.join(ctx.tempDir, '.index', 'knowledge.db'));
  try {
    if (values.createdAt !== undefined) db.query('UPDATE notes SET created_at = ? WHERE id = ?').run(values.createdAt, id);
    if (values.updatedAt !== undefined) db.query('UPDATE notes SET updated_at = ? WHERE id = ?').run(values.updatedAt, id);
  } finally {
    db.close();
  }
}

describe('knowledge-maintain review compatibility', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('applies the limit independently to fleeting and permanent queues and preserves zero-as-default behavior', async () => {
    const createdAt = Date.now() - 20 * DAY;
    for (let i = 0; i < 4; i++) {
      const fleeting = ctx.engine.store(`fleeting ${i}`, { title: `Fleeting ${i}`, kind: 'observation', status: 'fleeting', tags: ['project:demo'] });
      const permanent = ctx.engine.store(`permanent ${i}`, { title: `Permanent ${i}`, kind: 'reference', status: 'permanent', tags: ['project:demo'] });
      updateNote(ctx, fleeting.id, { createdAt });
      updateNote(ctx, permanent.id, { createdAt });
    }

    expect(await handleMaintain({ action: 'review', limit: 1 }, ctx.engine, ctx.config)).toContain('## Review Candidates (2 of 8)');
    expect(await handleMaintain({ action: 'review', limit: 0 }, ctx.engine, ctx.config)).toContain('## Review Candidates (6 of 8)');
  });

  it('uses note id as the deterministic final tie-break for an exact queue-sort tie', async () => {
    const createdAt = Date.now() - 20 * DAY;
    const notes = ['Tie C', 'Tie A', 'Tie B'].map(title => ctx.engine.store('body', {
      title, kind: 'observation', status: 'fleeting', tags: ['project:demo'],
    }));
    for (const note of notes) updateNote(ctx, note.id, { createdAt, updatedAt: createdAt });

    const output = await handleMaintain({ action: 'review', limit: 10 }, ctx.engine, ctx.config);
    const expected = [...notes].sort((a, b) => a.id.localeCompare(b.id));
    expect(expected.map(note => output.indexOf(`(${note.id})`))).toEqual([...expected].map(note => output.indexOf(`(${note.id})`)).sort((a, b) => a - b));
  });

  it('excludes archived backlink sources from recommendation evidence', async () => {
    const target = ctx.engine.store('target', { title: 'Archived Backlink Target', kind: 'observation', tags: ['project:demo'] });
    const source = ctx.engine.store(`[[${target.id}]]`, { title: 'Archived Source', kind: 'reference', tags: ['project:demo'] });
    ctx.engine.archive(source.id);
    updateNote(ctx, target.id, { createdAt: Date.now() - 50 * DAY });

    const output = await handleMaintain({ action: 'review', limit: 10 }, ctx.engine, ctx.config);
    const start = output.indexOf('"Archived Backlink Target"');
    const section = output.slice(start, output.indexOf('\n\n', start));
    expect(section).toContain('Backlinks: 0 (unlinked)');
    expect(section).toContain('Suggested: ARCHIVE');
  });

  it('preserves the candidate-present gate for oversized and long-title sections', async () => {
    ctx.engine.store(Array(400).fill('word').join(' '), {
      title: 'This deliberately oversized title also has seven words', kind: 'reference', status: 'fleeting', tags: ['project:demo'],
    });
    const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    expect(output).toBe('No notes pending review. All notes are up to date!');
  });
});

describe('knowledge-maintain preference-audit compatibility', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('preserves note, detector, evidence, de-duplication, and missing-applicability order', async () => {
    const first = ctx.engine.store('Temporarily and temporarily use /tmp/demo with #abc, claude-sonnet routing; configure TypeScript.', {
      title: 'First Preference', kind: 'personalization', status: 'permanent', tags: [],
    });
    const second = ctx.engine.store('For now use gpt-4 fallback and disable it later.', {
      title: 'Second Preference', kind: 'personalization', status: 'permanent', tags: [],
    });
    const output = await handleMaintain({ action: 'preference-audit' }, ctx.engine, ctx.config);

    expect(output.indexOf(`[${first.id}]`)).toBeLessThan(output.indexOf(`[${second.id}]`));
    const firstSection = output.slice(output.indexOf(`[${first.id}]`), output.indexOf(`\n### "Second Preference"`));
    const signalOrder = ['temporary-wording', 'exact-path', 'hex-color', 'model-identifier', 'model-routing', 'configuration-language', 'missing-applicability'];
    const positions = signalOrder.map(signal => firstSection.indexOf(`- ${signal}:`));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(firstSection.match(/"temporarily"/g)).toHaveLength(1);
  });
});

describe('review adapter public contract', () => {
  it('keeps the exact maintain actions and arguments unchanged', () => {
    expect(MAINTAIN_ACTIONS).toEqual([
      'promote', 'archive', 'delete', 'rebuild', 'format', 'upgrade', 'upgrade-read', 'upgrade-apply',
      'review', 'dedupe', 'embed', 'agent-docs', 'scope-audit', 'scope-inventory', 'assign-project',
      'preference-audit', 'unlinked', 'broken-links', 'link-health', 'migrate-layout', 'upgrade-vault',
      'full', 'publish-global', 'global-reference-audit',
    ]);
    const maintain = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-maintain');
    if (!maintain) throw new Error('knowledge-maintain metadata is missing');
    expect(Object.keys(maintain.params)).toEqual([
      'action', 'noteId', 'project', 'filter', 'days', 'limit', 'dryRun', 'candidate', 'confirm', 'token', 'model',
    ]);
  });
});
