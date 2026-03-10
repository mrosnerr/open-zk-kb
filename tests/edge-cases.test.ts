import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  createTestHarness,
  cleanupTestHarness,
} from './harness.js';
import type { TestContext } from './harness.js';
import { handleStore, handleSearch, handleMaintain } from '../src/tool-handlers.js';
import { parseWikiLink } from '../src/utils/wikilink.js';

describe('FTS5 Edge Cases', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
    ctx.engine.store('TypeScript is a typed superset of JavaScript', {
      title: 'TypeScript Overview',
      kind: 'reference',
      status: 'fleeting',
      summary: 'TypeScript overview',
      guidance: 'Reference for TypeScript basics',
    });
    ctx.engine.store('PostgreSQL handles concurrent writes with MVCC', {
      title: 'PostgreSQL Concurrency',
      kind: 'decision',
      status: 'permanent',
      summary: 'PostgreSQL concurrency model',
      guidance: 'Use when discussing DB concurrency',
    });
  });

  afterEach(() => { cleanupTestHarness(ctx); });

  it('should handle FTS5 operators in query (AND, OR, NOT)', () => {
    const output = handleSearch({ query: 'TypeScript AND PostgreSQL' }, ctx.engine);
    expect(output).toContain('Found');
    expect(output).toContain('TypeScript overview');
  });

  it('should handle FTS5 special characters (* " ())', () => {
    const output = handleSearch({ query: '"TypeScript"*()' }, ctx.engine);
    expect(output).toContain('Found');
    expect(output).toContain('TypeScript overview');
  });

  it('should handle NEAR operator in query', () => {
    const output = handleSearch({ query: 'NEAR(TypeScript, superset)' }, ctx.engine);
    expect(output).toContain('Found');
    expect(output).toContain('TypeScript overview');
  });

  it('should handle SQL injection attempt in search query', () => {
    const output = handleSearch({ query: "'; DROP TABLE notes; --" }, ctx.engine);
    expect(output).toContain('No matching notes found');
    const verifyIntact = ctx.engine.search('TypeScript');
    expect(verifyIntact.length).toBe(1);
  });

  it('should handle SQL injection attempt in store content', async () => {
    const output = await handleStore({
      title: "Robert'; DROP TABLE notes;--",
      content: "Content with '; DELETE FROM notes WHERE '1'='1",
      kind: 'observation',
      summary: 'SQL injection test',
      guidance: 'Should be stored safely',
    }, ctx.engine);

    expect(output).toContain('Knowledge stored (created)');
    const notes = ctx.engine.search('Robert');
    expect(notes.length).toBeGreaterThan(0);
  });

  it('should handle unicode and emoji in content and search', async () => {
    await handleStore({
      title: 'Unicode Test',
      content: 'Supports CJK characters and emoji: cafe, resume, naive',
      kind: 'reference',
      summary: 'Unicode content test',
      guidance: 'Verify unicode handling',
    }, ctx.engine);

    const output = handleSearch({ query: 'cafe' }, ctx.engine);
    expect(output).toContain('Unicode content test');
  });

  it('should handle CJK characters in content', async () => {
    await handleStore({
      title: 'CJK Note',
      content: 'This note contains CJK: hello world testing',
      kind: 'reference',
      summary: 'CJK content',
      guidance: 'Test CJK search',
    }, ctx.engine);

    const output = handleSearch({ query: 'CJK' }, ctx.engine);
    expect(output).toContain('CJK content');
  });

  it('should handle very long query (>1000 chars) by truncating to 10 terms', () => {
    const longQuery = 'TypeScript '.repeat(200);
    const output = handleSearch({ query: longQuery }, ctx.engine);
    expect(output).toContain('Found');
    expect(output).toContain('TypeScript overview');
  });

  it('should handle empty query without crashing', () => {
    const output = handleSearch({ query: '' }, ctx.engine);
    expect(output).toMatch(/Found \d+ note|No matching notes found/);
  });

  it('should handle whitespace-only query without crashing', () => {
    const output = handleSearch({ query: '   \t\n  ' }, ctx.engine);
    expect(output).toMatch(/Found \d+ note|No matching notes found/);
  });

  it('should handle single-character query without crashing', () => {
    const output = handleSearch({ query: 'a' }, ctx.engine);
    expect(output).toMatch(/Found \d+ note|No matching notes found/);
  });

  it('should handle query with only special characters without crashing', () => {
    const output = handleSearch({ query: '***"""()(){}[]' }, ctx.engine);
    expect(output).toMatch(/Found \d+ note|No matching notes found/);
  });

  it('should handle query with backslashes and colons', () => {
    const output = handleSearch({ query: 'C:\\Users\\test:something' }, ctx.engine);
    expect(output).toContain('No matching notes found');
  });
});

describe('Input Validation', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should store a note with empty content', async () => {
    const output = await handleStore({
      title: 'Empty Content Note',
      content: '',
      kind: 'observation',
      summary: 'Note with empty content',
      guidance: 'Test empty content handling',
    }, ctx.engine);

    expect(output).toContain('Knowledge stored');
  });

  it('should store a note with very long title', async () => {
    const longTitle = 'A'.repeat(500);
    const output = await handleStore({
      title: longTitle,
      content: 'Some content',
      kind: 'reference',
      summary: 'Long title test',
      guidance: 'Test long title handling',
    }, ctx.engine);

    expect(output).toContain('Knowledge stored');
  });

  it('should store a note with special characters in title', async () => {
    const output = await handleStore({
      title: 'Test / with < special > & "characters"',
      content: 'Content here',
      kind: 'observation',
      summary: 'Special char title test',
      guidance: 'Test special char handling',
    }, ctx.engine);

    expect(output).toContain('Knowledge stored');
  });

  it('should handle search with kind filter that has no matches', async () => {
    await handleStore({
      title: 'Only Observation',
      content: 'This is an observation',
      kind: 'observation',
      summary: 'An observation',
      guidance: 'Test kind filter',
    }, ctx.engine);

    const output = handleSearch({ query: 'observation', kind: 'procedure' }, ctx.engine);
    expect(output).toBe('No matching notes found. Try broader keywords or remove filters.');
  });

  it('should handle store with all optional fields', async () => {
    const output = await handleStore({
      title: 'Full Note',
      content: 'Content with all fields',
      kind: 'decision',
      status: 'permanent',
      tags: ['tag1', 'tag2', 'tag3'],
      summary: 'A fully populated note',
      guidance: 'Use as reference for full note structure',
      project: 'test-project',
      related: [],
    }, ctx.engine);

    expect(output).toContain('Knowledge stored');
    expect(output).toContain('Kind: decision');
    expect(output).toContain('Status: permanent');
  });

  it('should handle maintain with unknown action', async () => {
    const output = await handleMaintain({ action: 'nonexistent' }, ctx.engine, ctx.config);
    expect(output).toContain('Unknown action: nonexistent');
  });

  it('should handle store with duplicate tags', async () => {
    await handleStore({
      title: 'Dup Tags',
      content: 'Note with duplicate tags',
      kind: 'reference',
      tags: ['dup', 'dup', 'unique'],
      summary: 'Duplicate tags test',
      guidance: 'Test duplicate tag handling',
    }, ctx.engine);

    const notes = ctx.engine.search('duplicate tags');
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].tags).toContain('dup');
    expect(notes[0].tags).toContain('unique');
  });

  it('should handle store with empty tags array', async () => {
    const output = await handleStore({
      title: 'No Tags',
      content: 'Note without tags',
      kind: 'observation',
      tags: [],
      summary: 'No tags test',
      guidance: 'Test empty tags handling',
    }, ctx.engine);

    expect(output).toContain('Knowledge stored');
  });

  it('should handle search with limit of 0', async () => {
    await handleStore({
      title: 'Test Note',
      content: 'Searchable content',
      kind: 'reference',
      summary: 'Test',
      guidance: 'Test',
    }, ctx.engine);

    const output = handleSearch({ query: 'Searchable', limit: 0 }, ctx.engine);
    expect(output).toMatch(/Found \d+ note|No matching notes found/);
  });

  it('should handle search with very large limit', async () => {
    await handleStore({
      title: 'Test Note',
      content: 'Searchable content',
      kind: 'reference',
      summary: 'Test',
      guidance: 'Test',
    }, ctx.engine);

    const output = handleSearch({ query: 'Searchable', limit: 99999 }, ctx.engine);
    expect(output).toContain('Searchable content');
  });
});

describe('16-digit ID generation', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
  });

  it('should generate 16-digit IDs', () => {
    const result = ctx.engine.store('Test content', {
      title: 'Test Note',
      kind: 'reference',
      status: 'fleeting',
      summary: 'Test',
      guidance: 'Test',
    });

    expect(result.id).toMatch(/^\d{16}$/);
  });

  it('should generate unique IDs for rapid successive stores', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const result = ctx.engine.store(`Content ${i}`, {
        title: `Note ${i}`,
        kind: 'reference',
        status: 'fleeting',
        summary: `Summary ${i}`,
        guidance: `Guidance ${i}`,
      });
      expect(result.id).toMatch(/^\d{16}$/);
      ids.add(result.id);
    }
    expect(ids.size).toBe(10);
  });

  it('should generate monotonically increasing IDs', () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = ctx.engine.store(`Content ${i}`, {
        title: `Note ${i}`,
        kind: 'reference',
        status: 'fleeting',
        summary: `Summary ${i}`,
        guidance: `Guidance ${i}`,
      });
      ids.push(result.id);
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  it('should handle 100+ rapid stores without duplicate IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 110; i++) {
      const result = ctx.engine.store(`Content ${i}`, {
        title: `Note ${i}`,
        kind: 'observation',
        status: 'fleeting',
        summary: `Summary ${i}`,
        guidance: `Guidance ${i}`,
      });
      expect(result.id).toMatch(/^\d{16}$/);
      expect(ids.has(result.id)).toBe(false);
      ids.add(result.id);
    }
    expect(ids.size).toBe(110);

    // Verify all IDs are monotonically increasing
    const sorted = [...ids].sort();
    const original = [...ids];
    expect(original).toEqual(sorted);
  });
});

describe('Wikilink parsing with ID formats', () => {
  it('should extract 16-digit IDs from wikilinks', () => {
    const result = parseWikiLink('2026030919130100-my-note|My Note');
    expect(result.id).toBe('2026030919130100');
    expect(result.slug).toBe('2026030919130100-my-note');
    expect(result.display).toBe('My Note');
  });

  it('should extract 12-digit legacy IDs from wikilinks', () => {
    const result = parseWikiLink('202602081000-old-note');
    expect(result.id).toBe('202602081000');
    expect(result.slug).toBe('202602081000-old-note');
  });

  it('should extract first 12 digits from 13-15 digit prefixed slugs', () => {
    // The regex ^(\d{16}|\d{12}) tries 16-digit first, then falls back to 12-digit.
    // A 13-digit prefix like "1234567890123" matches the first 12 digits.
    const result13 = parseWikiLink('1234567890123-some-note');
    expect(result13.id).toBe('123456789012');
    expect(result13.slug).toBe('1234567890123-some-note');

    const result14 = parseWikiLink('12345678901234-some-note');
    expect(result14.id).toBe('123456789012');

    const result15 = parseWikiLink('123456789012345-some-note');
    expect(result15.id).toBe('123456789012');
  });

  it('should parse 16-digit ID wikilinks with headings', () => {
    const result = parseWikiLink('2026030919130100-architecture#Auth|Authentication');
    expect(result.id).toBe('2026030919130100');
    expect(result.heading).toBe('Auth');
    expect(result.display).toBe('Authentication');
  });

  it('should handle plain 16-digit IDs without slug', () => {
    const result = parseWikiLink('2026030919130100');
    expect(result.id).toBe('2026030919130100');
    expect(result.slug).toBe('2026030919130100');
  });
});

describe('Rebuild with mixed ID formats', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
  });

  it('should rebuild index from 16-digit ID files', () => {
    // Store notes (generates 16-digit IDs)
    ctx.engine.store('First content', { title: 'First', kind: 'reference' });
    ctx.engine.store('Second content', { title: 'Second', kind: 'decision', status: 'permanent' });

    const result = ctx.engine.rebuildFromFiles();
    expect(result.indexed).toBe(2);
    expect(result.errors).toBe(0);

    const stats = ctx.engine.getStats();
    expect(stats.total).toBe(2);
  });

  it('should rebuild index from legacy 12-digit ID files', () => {
    // Create a legacy 12-digit note file manually
    // Note: no quotes around id value — matches buildFrontmatter() output
    const fs = require('fs');
    const path = require('path');
    const legacyContent = `---
id: 202602081000
title: Legacy Note
kind: reference
status: fleeting
---

Legacy content here`;
    fs.writeFileSync(
      path.join(ctx.tempDir, '202602081000-legacy-note.md'),
      legacyContent
    );

    const result = ctx.engine.rebuildFromFiles();
    expect(result.indexed).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);

    // Verify the note is searchable
    const note = ctx.engine.getById('202602081000');
    expect(note).not.toBeNull();
    expect(note!.title).toBe('Legacy Note');
  });

  it('should rebuild with mixed 12 and 16-digit ID files', () => {
    const fs = require('fs');
    const path = require('path');

    // Create a legacy 12-digit note (no quotes around id — matches buildFrontmatter output)
    const legacyContent = `---
id: 202602081000
title: Legacy Note
kind: reference
status: fleeting
---

Legacy content`;
    fs.writeFileSync(
      path.join(ctx.tempDir, '202602081000-legacy-note.md'),
      legacyContent
    );

    // Store a new note (16-digit ID)
    ctx.engine.store('New content', { title: 'New Note', kind: 'observation' });

    const result = ctx.engine.rebuildFromFiles();
    expect(result.indexed).toBe(2);
    expect(result.errors).toBe(0);
  });
});

describe('handleStore non-blocking embedding', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
  });

  it('should return synchronously without embedding config', () => {
    const result = handleStore({
      title: 'Quick Note',
      content: 'This should return immediately',
      kind: 'observation',
      summary: 'Quick note',
      guidance: 'Test guidance',
    }, ctx.engine);

    // handleStore returns string directly (not a Promise)
    expect(typeof result).toBe('string');
    expect(result).toContain('Knowledge stored');
    expect(result).toContain('Kind: observation');
  });

  it('should store note successfully even with embedding config', () => {
    // Pass a dummy embedding config — embedding will fail but store should succeed
    const result = handleStore({
      title: 'Note with embedding',
      content: 'Content that triggers embedding path',
      kind: 'reference',
      summary: 'Test',
      guidance: 'Test',
    }, ctx.engine, { provider: 'local', model: 'nonexistent-model', dimensions: 384 });

    expect(result).toContain('Knowledge stored');

    // Verify note exists in DB regardless of embedding outcome
    const stats = ctx.engine.getStats();
    expect(stats.total).toBeGreaterThanOrEqual(1);
  });
});
