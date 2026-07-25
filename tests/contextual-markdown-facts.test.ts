import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { extractContextualMarkdownFacts, type ContextualMarkdownFacts } from '../src/markdown/contextual-facts';
import { cleanupTestHarness, createTestHarness, listAllNoteFiles, type TestContext } from './harness';

function facts(source: string): ContextualMarkdownFacts {
  const result = extractContextualMarkdownFacts(source);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  for (const segment of result.textSegments) {
    expect(source.slice(segment.range.start.offset, segment.range.end.offset)).toBe(segment.rawSource);
  }
  for (const link of result.wikilinks) {
    expect(source.slice(link.range.start.offset, link.range.end.offset)).toBe(link.rawSource);
  }
  return result;
}

function fileSnapshot(ctx: TestContext): Record<string, string> {
  return Object.fromEntries(listAllNoteFiles(ctx).map(relative => [
    relative,
    createHash('sha256').update(fs.readFileSync(path.join(ctx.tempDir, relative))).digest('hex'),
  ]));
}

function databaseSnapshot(ctx: TestContext): Record<string, unknown[]> {
  const db = new Database(path.join(ctx.tempDir, '.index', 'knowledge.db'), { readonly: true });
  try {
    return {
      notes: db.query('SELECT * FROM notes ORDER BY id').all(),
      links: db.query('SELECT * FROM note_links ORDER BY source_id, target_id').all(),
      embeddings: db.query('SELECT id, hex(embedding), embedding_model FROM notes ORDER BY id').all(),
      hashes: db.query('SELECT id, content_hash FROM notes ORDER BY id').all(),
      conformance: db.query('SELECT * FROM template_conformance ORDER BY id').all(),
      telemetry: db.query('SELECT * FROM tool_telemetry ORDER BY id').all(),
      sessions: db.query('SELECT * FROM sessions ORDER BY session_id').all(),
    };
  } finally {
    db.close();
  }
}

describe('contextual Markdown facts', () => {
  it('includes authored leaf text contexts in source order', () => {
    const source = [
      'Paragraph [[1000000000000001]].',
      '# Heading [[1000000000000002]]',
      '*em [[1000000000000003]]* and **strong [[1000000000000004]]**',
      '> quote [[1000000000000005]]',
      '- item [[1000000000000006]]',
      '[label [[1000000000000007]]](https://example.test)',
      '<span>[[1000000000000008]]</span>',
    ].join('\n');
    expect(facts(source).wikilinks.map(link => link.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `100000000000000${index + 1}`),
    );
  });

  it('excludes frontmatter, code, inline code, HTML, images, and definitions', () => {
    const source = [
      '---', 'key: "[[1000000000000001]]"', '---',
      '```md', '[[1000000000000002]]', '```',
      '`[[1000000000000003]]`',
      '<div>[[1000000000000004]]</div>',
      '',
      '![alt [[1000000000000005]]](image.png)',
      '',
      '[reference]: https://example.test "[[1000000000000006]]"',
      '',
      'prose [[1000000000000007]]',
    ].join('\n');
    expect(facts(source).wikilinks.map(link => link.id)).toEqual(['1000000000000007']);
  });

  it('conservatively excludes malformed closed and unterminated leading frontmatter', () => {
    const closed = '---\n: bad: yaml [[1000000000000001]]\n---\nbody [[1000000000000002]]';
    expect(facts(closed).wikilinks.map(link => link.id)).toEqual(['1000000000000002']);
    expect(facts('---\nmeta: [[1000000000000001]]\nbody [[1000000000000002]]').wikilinks).toEqual([]);
  });

  it('keeps repeated links distinct, respects node boundaries, and handles escaped openings', () => {
    const source = String.raw`[[1000000000000001]] [[1000000000000001]] \[[1000000000000002]] \\[[1000000000000003]] [[broken *across]]*`;
    expect(facts(source).wikilinks.map(link => link.id)).toEqual([
      '1000000000000001', '1000000000000001', '1000000000000003',
    ]);
  });

  it('returns normalized values with exact raw slices', () => {
    const source = String.raw`Escaped \*star\* &amp; [[1000000000000001#Head| Display ]]`;
    const result = facts(source);
    expect(result.textSegments[0]?.value).toBe('Escaped *star* & [[1000000000000001#Head| Display ]]');
    expect(result.textSegments[0]?.rawSource).toBe(source);
    expect(result.wikilinks[0]).toMatchObject({
      slug: '1000000000000001', id: '1000000000000001', heading: 'Head', display: 'Display',
      rawSource: '[[1000000000000001#Head| Display ]]',
    });
  });

  it('reports exact zero-based UTF-16 ranges for LF, CRLF, and astral text', () => {
    for (const [source, expected] of [
      ['first\n😀 [[1000000000000001]]', { offset: 9, line: 1, character: 3, ending: 'lf' }],
      ['first\r\n😀 [[1000000000000001]]', { offset: 10, line: 1, character: 3, ending: 'crlf' }],
    ] as const) {
      const result = facts(source);
      const link = result.wikilinks[0];
      expect(result.lineEnding).toBe(expected.ending);
      expect(link?.range.start).toEqual({ offset: expected.offset, line: expected.line, character: expected.character });
      expect(source.slice(link?.range.start.offset, link?.range.end.offset)).toBe(link?.rawSource);
      for (const segment of result.textSegments) {
        expect(source.slice(segment.range.start.offset, segment.range.end.offset)).toBe(segment.rawSource);
      }
    }
  });

  it('returns a frozen typed failure instead of a raw fallback after unexpected parser input', () => {
    const result = extractContextualMarkdownFacts(Symbol('invalid source') as unknown as string);
    expect(result.ok).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok) throw new Error('expected parser failure');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('is deterministic and deeply frozen', () => {
    const source = 'Text [[1000000000000001#H|D]].';
    const first = facts(source);
    expect(facts(source)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.textSegments)).toBe(true);
    expect(Object.isFrozen(first.textSegments[0]?.range.start)).toBe(true);
    expect(Object.isFrozen(first.wikilinks)).toBe(true);
    expect(Object.isFrozen(first.wikilinks[0]?.range.end)).toBe(true);
    expect(() => (first.wikilinks as unknown as unknown[]).push({})).toThrow();
    expect(() => { (first.wikilinks[0] as { slug: string }).slug = 'changed'; }).toThrow();
    expect(facts(source)).toEqual(first);
  });
});

describe('contextual Markdown extraction is read-only', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness({ telemetryEnabled: true }); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('does not change Markdown, navigation, or indexed state', () => {
    const target = ctx.engine.store('Target', { title: 'Target', kind: 'reference' });
    ctx.engine.store(`Body [[${target.id}]]`, { title: 'Source', kind: 'reference' });
    const beforeFiles = fileSnapshot(ctx);
    const beforeDatabase = databaseSnapshot(ctx);
    for (const relative of listAllNoteFiles(ctx)) {
      facts(fs.readFileSync(path.join(ctx.tempDir, relative), 'utf8'));
    }
    expect(fileSnapshot(ctx)).toEqual(beforeFiles);
    expect(databaseSnapshot(ctx)).toEqual(beforeDatabase);
  });
});
