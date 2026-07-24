import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildReviewSnapshot } from '../src/review/facts';
import { createRepositoryReviewReader } from '../src/review/reader';
import { evaluateReview } from '../src/review/registry';
import { cleanupTestHarness, createTestHarness, listAllNoteFiles, type TestContext } from './harness';

function fileSnapshot(ctx: TestContext): Record<string, string> {
  return Object.fromEntries(listAllNoteFiles(ctx).map(relative => {
    const bytes = fs.readFileSync(path.join(ctx.tempDir, relative));
    return [relative, createHash('sha256').update(bytes).digest('hex')];
  }));
}

function databaseSnapshot(ctx: TestContext): Record<string, unknown[]> {
  const db = new Database(path.join(ctx.tempDir, '.index', 'knowledge.db'), { readonly: true });
  try {
    return {
      notes: db.query('SELECT id, path, title, content, kind, status, lifecycle, type, tags, context, created_at, updated_at, word_count, access_count, last_accessed_at, summary, guidance, hex(embedding) AS embedding, embedding_model, content_hash FROM notes ORDER BY id').all(),
      links: db.query('SELECT source_id, target_id, link_text, created_at FROM note_links ORDER BY source_id, target_id').all(),
      conformance: db.query('SELECT * FROM template_conformance ORDER BY id').all(),
      telemetry: db.query('SELECT * FROM tool_telemetry ORDER BY id').all(),
      sessions: db.query('SELECT * FROM sessions ORDER BY session_id').all(),
    };
  } finally {
    db.close();
  }
}

describe('vault-review core: read-only state', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness({ telemetryEnabled: true }); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('does not change Markdown/navigation files or indexed state during fact building and evaluation', () => {
    const target = ctx.engine.store('Temporarily configure claude-sonnet routing.', {
      title: 'Review Target', kind: 'personalization', tags: ['project:demo'], summary: 'Temporary choice', guidance: 'Review manually',
    });
    ctx.engine.store(`Links to [[${target.id}]]`, { title: 'Source', kind: 'reference', tags: ['project:demo'] });

    const beforeFiles = fileSnapshot(ctx);
    const beforeDatabase = databaseSnapshot(ctx);
    const scope = { kind: 'full' } as const;
    const now = Date.now();
    const snapshot = buildReviewSnapshot(createRepositoryReviewReader(ctx.engine), scope, now);
    evaluateReview({ scope, now }, snapshot);
    evaluateReview({ scope, profile: 'preference', now }, snapshot);

    expect(fileSnapshot(ctx)).toEqual(beforeFiles);
    expect(databaseSnapshot(ctx)).toEqual(beforeDatabase);
  });
});
