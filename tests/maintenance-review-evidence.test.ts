import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { handleMaintain } from '../src/tool-handlers.js';
import { cleanupTestHarness, createTestHarness, type TestContext } from './harness.js';

function accessMetadata(ctx: TestContext, id: string): { access_count: number; last_accessed_at: number | null } {
  const db = new Database(path.join(ctx.tempDir, '.index', 'knowledge.db'), { readonly: true });
  try {
    return db.query('SELECT access_count, last_accessed_at FROM notes WHERE id = ?').get(id) as {
      access_count: number;
      last_accessed_at: number | null;
    };
  } finally {
    db.close();
  }
}

function makeOld(ctx: TestContext, id: string): void {
  const db = new Database(path.join(ctx.tempDir, '.index', 'knowledge.db'));
  try {
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    db.query('UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?').run(old, old, id);
  } finally {
    db.close();
  }
}

describe('maintenance review evidence', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('bounds snapshot summary and guidance and leaves access metadata unchanged', async () => {
    const stored = ctx.engine.store('Fallback content should not be rendered.', {
      title: 'Old candidate',
      kind: 'observation',
      status: 'fleeting',
      summary: `Summary   evidence ${'s'.repeat(400)}`,
      guidance: `Guidance\n evidence ${'g'.repeat(400)}`,
    });
    makeOld(ctx, stored.id);
    const before = accessMetadata(ctx, stored.id);

    const fixedNow = Date.now();
    const clock = () => fixedNow;
    const first = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config, undefined, undefined, undefined, clock);
    const second = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config, undefined, undefined, undefined, clock);
    const after = accessMetadata(ctx, stored.id);

    expect(first).toBe(second);
    expect(first).toContain('Summary: Summary evidence');
    expect(first).toContain('Guidance: Guidance evidence');
    expect(first).not.toContain('Fallback content should not be rendered');
    const summaryLine = first.split('\n').find(line => line.startsWith('Summary:'));
    const guidanceLine = first.split('\n').find(line => line.startsWith('Guidance:'));
    expect(summaryLine?.endsWith('…')).toBe(true);
    expect(guidanceLine?.endsWith('…')).toBe(true);
    expect(summaryLine?.length).toBeLessThanOrEqual('Summary: '.length + 240);
    expect(guidanceLine?.length).toBeLessThanOrEqual('Guidance: '.length + 240);
    const renderedEvidenceChars = (summaryLine?.slice('Summary: '.length).length ?? 0)
      + (guidanceLine?.slice('Guidance: '.length).length ?? 0);
    expect(renderedEvidenceChars).toBeLessThanOrEqual(240);
    expect(after).toEqual(before);
  });

  it('bounds fallback content when summary and guidance are absent', async () => {
    const stored = ctx.engine.store(`Fallback evidence ${'x'.repeat(400)}`, {
      title: 'Fallback candidate', kind: 'observation', status: 'fleeting',
    });
    makeOld(ctx, stored.id);

    const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    const evidenceLine = output.split('\n').find(line => line.startsWith('Evidence:'));

    expect(evidenceLine).toContain('Evidence: Fallback evidence');
    expect(evidenceLine?.endsWith('…')).toBe(true);
    expect(evidenceLine?.length).toBeLessThanOrEqual('Evidence: '.length + 240);
  });
});
