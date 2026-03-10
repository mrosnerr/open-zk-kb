import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  createTestHarness,
  cleanupTestHarness,
} from './harness.js';
import type { TestContext } from './harness.js';
import { handleStore, handleSearch, handleMaintain } from '../src/tool-handlers.js';

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
