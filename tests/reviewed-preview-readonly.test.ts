import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleStore } from '../src/tool-handlers.js';
import { cleanupTestHarness, createTestHarness, listAllNoteFiles, type TestContext } from './harness.js';

function logicalSnapshot(ctx: TestContext) {
  const files = Object.fromEntries(listAllNoteFiles(ctx).map(relative => [
    relative,
    createHash('sha256').update(fs.readFileSync(path.join(ctx.tempDir, relative))).digest('hex'),
  ]));
  const db = new Database(path.join(ctx.tempDir, '.index', 'knowledge.db'), { readonly: true });
  try {
    return {
      files,
      notes: db.query('SELECT id, path, title, content, kind, status, lifecycle, tags, created_at, updated_at, access_count, last_accessed_at, summary, guidance, hex(embedding) AS embedding, embedding_model, content_hash FROM notes ORDER BY id').all(),
      links: db.query('SELECT * FROM note_links ORDER BY source_id, target_id').all(),
      conformance: db.query('SELECT * FROM template_conformance ORDER BY id').all(),
      telemetry: db.query('SELECT * FROM tool_telemetry ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}

describe('reviewed store preview logical immutability', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness({ telemetryEnabled: false }); });
  afterEach(() => cleanupTestHarness(ctx));

  it('leaves canonical files, database tables, navigation, and logs identical', async () => {
    await handleStore({
      project: 'demo', title: 'Preview Immutable Target', content: 'canonical preview content', kind: 'reference',
      summary: 'Canonical preview summary.', guidance: 'Keep canonical preview state.',
    }, ctx.engine, null, ctx.config);
    const before = logicalSnapshot(ctx);

    const output = await handleStore({
      project: 'demo', title: 'Preview Immutable Target', content: 'candidate preview content', kind: 'reference',
      summary: 'Candidate preview summary.', guidance: 'Review candidate only.', dryRun: true,
    }, ctx.engine, null, ctx.config);

    expect(output).toContain('"mutated":false');
    expect(logicalSnapshot(ctx)).toEqual(before);
  });
});
