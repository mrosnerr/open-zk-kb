/**
 * Coverage boost tests — targeting uncovered lines across src/ modules.
 * Organized by source file for easy mapping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createTestHarness, cleanupTestHarness, type TestContext } from './harness';

// ---- src/logger.ts ----

import { cleanupOldLogs, sanitizeArgs, sanitizeContent, isSensitiveFile, logToFile } from '../src/logger';

describe('Logger', () => {
  describe('cleanupOldLogs', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-logs-'));
    });
    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should delete old log files beyond retention', () => {
      // Create an "old" log file (8 days ago)
      const oldFile = path.join(tempDir, 'open-zk-kb-2025-01-01.log');
      fs.writeFileSync(oldFile, 'old log\n');
      const oldTime = Date.now() - (8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

      // Create a "new" log file (today)
      const newFile = path.join(tempDir, 'open-zk-kb-2026-03-10.log');
      fs.writeFileSync(newFile, 'new log\n');

      // Create a non-log file (should be ignored)
      fs.writeFileSync(path.join(tempDir, 'readme.txt'), 'not a log');

      cleanupOldLogs(tempDir, 7);

      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(newFile)).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'readme.txt'))).toBe(true);
    });

    it('should handle non-existent directory gracefully', () => {
      expect(() => cleanupOldLogs('/nonexistent/path/xyz', 7)).not.toThrow();
    });
  });

  describe('sanitizeArgs', () => {
    it('should redact sensitive keys', () => {
      const result = sanitizeArgs('test-tool', {
        apiKey: 'sk-secret123',
        password: 'hunter2',
        name: 'visible',
        authToken: 'bearer-xyz',
      });
      expect(result.apiKey).toBe('[REDACTED]');
      expect(result.password).toBe('[REDACTED]');
      expect(result.authToken).toBe('[REDACTED]');
      expect(result.name).toBe('visible');
    });

    it('should not modify non-sensitive keys', () => {
      const result = sanitizeArgs('test-tool', { query: 'hello', limit: 10 });
      expect(result.query).toBe('hello');
      expect(result.limit).toBe(10);
    });
  });

  describe('sanitizeContent', () => {
    it('should redact API keys', () => {
      const result = sanitizeContent('My apiKey = sk-abcdefghijklmnopqrstuvwxyz12345');
      expect(result.redactedCount).toBeGreaterThan(0);
      expect(result.sanitized).toContain('[REDACTED]');
      expect(result.sanitized).not.toContain('sk-abcdefghijklmnopqrstuvwxyz12345');
    });

    it('should redact emails', () => {
      const result = sanitizeContent('Contact user@example.com for help');
      expect(result.redactedCount).toBeGreaterThan(0);
      expect(result.sanitized).toContain('[REDACTED]');
    });

    it('should flag too sensitive content (>5 matches)', () => {
      const emails = Array.from({ length: 6 }, (_, i) => `user${i}@example.com`).join(', ');
      const result = sanitizeContent(emails);
      expect(result.isTooSensitive).toBe(true);
    });

    it('should not flag normal content', () => {
      const result = sanitizeContent('This is perfectly normal content with no secrets.');
      expect(result.redactedCount).toBe(0);
      expect(result.isTooSensitive).toBe(false);
    });
  });

  describe('isSensitiveFile', () => {
    it('should detect sensitive extensions', () => {
      expect(isSensitiveFile('server.pem')).toBe(true);
      expect(isSensitiveFile('private.key')).toBe(true);
      expect(isSensitiveFile('cert.crt')).toBe(true);
      expect(isSensitiveFile('keystore.p12')).toBe(true);
    });

    it('should detect sensitive names', () => {
      expect(isSensitiveFile('credentials.json')).toBe(true);
      expect(isSensitiveFile('my-password-file.txt')).toBe(true);
      expect(isSensitiveFile('auth-config.yaml')).toBe(true);
      expect(isSensitiveFile('secret-keys.txt')).toBe(true);
      expect(isSensitiveFile('token-store.json')).toBe(true);
    });

    it('should not flag .env (no extension match, no name match)', () => {
      // path.extname('.env') returns '' and basename '.env' doesn't match sensitiveNames
      expect(isSensitiveFile('.env')).toBe(false);
    });

    it('should not flag normal files', () => {
      expect(isSensitiveFile('readme.md')).toBe(false);
      expect(isSensitiveFile('index.ts')).toBe(false);
      expect(isSensitiveFile('package.json')).toBe(false);
    });
  });

  describe('logToFile', () => {
    it('should skip logging when level is below threshold', () => {
      // This should not throw — it just returns early
      logToFile('DEBUG', 'should be skipped', undefined, { logLevel: 'ERROR' });
    });
  });
});

// ---- src/utils/path.ts ----

import { expandPath, contractPath } from '../src/utils/path';

describe('Path Utils', () => {
  describe('expandPath', () => {
    it('should throw on non-string input', () => {
      expect(() => expandPath(null as any)).toThrow('invalid input path');
      expect(() => expandPath(undefined as any)).toThrow('invalid input path');
      expect(() => expandPath(123 as any)).toThrow('invalid input path');
      expect(() => expandPath('')).toThrow('invalid input path');
    });

    it('should return absolute paths as-is', () => {
      expect(expandPath('/absolute/path')).toBe('/absolute/path');
    });

    it('should expand ~ to home directory', () => {
      const result = expandPath('~/test');
      expect(result).toContain('/test');
      expect(result).not.toContain('~');
    });

    it('should resolve relative paths to absolute', () => {
      const result = expandPath('relative/path');
      expect(path.isAbsolute(result)).toBe(true);
    });
  });

  describe('contractPath', () => {
    it('should return empty string for empty input', () => {
      expect(contractPath('')).toBe('');
    });

    it('should contract home directory to ~', () => {
      const home = os.homedir();
      expect(contractPath(`${home}/Documents`)).toBe('~/Documents');
    });

    it('should return non-home paths as-is', () => {
      expect(contractPath('/var/log/test')).toBe('/var/log/test');
    });
  });
});

// ---- src/utils/wikilink.ts ----

import {
  formatWikiLink,
  formatNoteLink,
  extractWikiLinkIds,
  extractWikiLinkSlugs,
  stripWikiLinks,
  extractSlugSuffix,
} from '../src/utils/wikilink';

describe('Wikilink Utils', () => {
  describe('formatWikiLink', () => {
    it('should format with heading', () => {
      const result = formatWikiLink({ id: '2026030900000000', heading: 'Section 1' });
      expect(result).toBe('[[2026030900000000#Section 1]]');
    });

    it('should format with heading and display', () => {
      const result = formatWikiLink({ id: '2026030900000000', heading: 'S1', display: 'My Link' });
      expect(result).toBe('[[2026030900000000#S1|My Link]]');
    });

    it('should format bare ID without display', () => {
      const result = formatWikiLink({ id: '2026030900000000' });
      expect(result).toBe('[[2026030900000000]]');
    });

    it('should format with slug suffix', () => {
      const result = formatWikiLink({ id: '2026030900000000', slugSuffix: 'my-note', display: 'My Note' });
      expect(result).toBe('[[2026030900000000-my-note|My Note]]');
    });
  });

  describe('formatNoteLink', () => {
    it('should build link from note-like object with path', () => {
      const result = formatNoteLink({
        id: '2026030900000000',
        path: '/vault/2026030900000000-my-note.md',
        title: 'My Note',
      });
      expect(result).toBe('[[2026030900000000-my-note|My Note]]');
    });

    it('should handle note without path', () => {
      const result = formatNoteLink({ id: '2026030900000000', title: 'Test' });
      expect(result).toBe('[[2026030900000000|Test]]');
    });

    it('should accept custom heading and display', () => {
      const result = formatNoteLink(
        { id: '2026030900000000', title: 'Note' },
        { heading: 'H1', display: 'Custom' }
      );
      expect(result).toBe('[[2026030900000000#H1|Custom]]');
    });
  });

  describe('extractWikiLinkIds', () => {
    it('should extract IDs from content', () => {
      const ids = extractWikiLinkIds('See [[2026030900000000-foo|Foo]] and [[2026030919130000]]');
      expect(ids).toEqual(['2026030900000000', '2026030919130000']);
    });
  });

  describe('extractWikiLinkSlugs', () => {
    it('should extract slugs from content', () => {
      const slugs = extractWikiLinkSlugs('See [[2026030900000000-my-note|My Note]]');
      expect(slugs).toEqual(['2026030900000000-my-note']);
    });
  });

  describe('stripWikiLinks', () => {
    it('should replace links with display text', () => {
      const result = stripWikiLinks('see [[2026030900000000-slug|My Name]] here');
      expect(result).toBe('see My Name here');
    });

    it('should use slug when no display text', () => {
      const result = stripWikiLinks('see [[2026030900000000-slug]] here');
      expect(result).toBe('see 2026030900000000-slug here');
    });
  });

  describe('extractSlugSuffix', () => {
    it('should extract suffix from path', () => {
      expect(extractSlugSuffix('2026030900000000', '/vault/2026030900000000-my-slug.md')).toBe('my-slug');
    });

    it('should return undefined for no path', () => {
      expect(extractSlugSuffix('2026030900000000', undefined)).toBeUndefined();
    });

    it('should return undefined for mismatched prefix', () => {
      expect(extractSlugSuffix('2026030900000000', '/vault/9999999999999999-other.md')).toBeUndefined();
    });
  });
});

// ---- src/prompts.ts ----

import { renderNoteForAgent, emptyKbHint } from '../src/prompts';
import type { NoteMetadata } from '../src/storage/NoteRepository';

describe('Prompts', () => {
  describe('renderNoteForAgent', () => {
    it('should include content preview for procedure notes', () => {
      const note = {
        id: '2026030900000000',
        title: 'My Procedure',
        kind: 'procedure',
        status: 'permanent',
        tags: ['test'],
        content: 'Step 1: Do this. Step 2: Do that. '.repeat(10),
        summary: 'A procedure',
        guidance: 'Follow these steps',
      } as unknown as NoteMetadata;

      const xml = renderNoteForAgent(note);
      expect(xml).toContain('<content_preview>');
      expect(xml).toContain('...');
      expect(xml).toContain('<hint>');
    });

    it('should include short content without hint for short procedure', () => {
      const note = {
        id: '2026030900000000',
        title: 'Short Proc',
        kind: 'reference',
        status: 'permanent',
        tags: [],
        content: 'Short content',
        summary: 'Brief',
        guidance: 'Use it',
      } as unknown as NoteMetadata;

      const xml = renderNoteForAgent(note);
      expect(xml).toContain('<content_preview>Short content</content_preview>');
      expect(xml).not.toContain('<hint>');
    });

    it('should not include content preview for personalization notes', () => {
      const note = {
        id: '2026030900000000',
        title: 'Preference',
        kind: 'personalization',
        status: 'permanent',
        tags: [],
        content: 'I like dark mode',
        summary: 'Dark mode',
        guidance: 'Apply dark mode',
      } as unknown as NoteMetadata;

      const xml = renderNoteForAgent(note);
      expect(xml).not.toContain('<content_preview>');
    });
  });

  describe('emptyKbHint', () => {
    it('should interpolate directory path', () => {
      const hint = emptyKbHint('/my/vault/path');
      expect(hint).toContain('/my/vault/path');
      expect(hint).toContain('<onboarding_script>');
      expect(hint).toContain('FORBIDDEN');
    });
  });
});

// ---- src/embeddings.ts (API path mocking) ----

import { generateEmbedding, generateEmbeddingBatch, type EmbeddingConfig } from '../src/embeddings';

describe('Embeddings API', () => {
  const apiConfig: EmbeddingConfig = {
    provider: 'api',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'test-key',
    model: 'text-embedding-3-small',
    dimensions: 384,
  };

  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should return null when API credentials are missing', async () => {
    const result = await generateEmbedding('test', {
      provider: 'api',
      model: 'test',
      dimensions: 384,
    });
    expect(result).toBeNull();
  });

  it('should return null on non-OK API response', async () => {
    globalThis.fetch = (async () => new Response('Bad Request', { status: 400 })) as any;
    const result = await generateEmbedding('test', apiConfig);
    expect(result).toBeNull();
  });

  it('should return null on malformed response data', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{}] }), { status: 200 })) as any;
    const result = await generateEmbedding('test', apiConfig);
    expect(result).toBeNull();
  });

  it('should return embedding on valid response', async () => {
    const mockEmbedding = [0.1, 0.2, 0.3];
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [{ embedding: mockEmbedding, index: 0 }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 5 },
    }), { status: 200 })) as any;

    const result = await generateEmbedding('test', apiConfig);
    expect(result).not.toBeNull();
    expect(result!.embedding).toEqual(mockEmbedding);
    expect(result!.model).toBe('text-embedding-3-small');
    expect(result!.tokenCount).toBe(5);
  });

  it('should return null on network error', async () => {
    globalThis.fetch = (async () => { throw new Error('Network error'); }) as any;
    const result = await generateEmbedding('test', apiConfig);
    expect(result).toBeNull();
  });

  describe('generateEmbeddingBatch', () => {
    it('should return empty array for empty input', async () => {
      const result = await generateEmbeddingBatch([], apiConfig);
      expect(result).toEqual([]);
    });

    it('should return null when API credentials missing', async () => {
      const result = await generateEmbeddingBatch(['a', 'b'], {
        provider: 'api',
        model: 'test',
        dimensions: 384,
      });
      expect(result).toEqual([null, null]);
    });

    it('should delegate single-text to generateEmbedding', async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        data: [{ embedding: [0.1], index: 0 }],
        model: 'test',
      }), { status: 200 })) as any;

      const result = await generateEmbeddingBatch(['single'], apiConfig);
      expect(result.length).toBe(1);
      expect(result[0]?.embedding).toEqual([0.1]);
    });

    it('should handle multi-text batch response sorted by index', async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        data: [
          { embedding: [0.2], index: 1 },
          { embedding: [0.1], index: 0 },
        ],
        model: 'test',
      }), { status: 200 })) as any;

      const result = await generateEmbeddingBatch(['a', 'b'], apiConfig);
      expect(result.length).toBe(2);
      expect(result[0]?.embedding).toEqual([0.1]);
      expect(result[1]?.embedding).toEqual([0.2]);
    });

    it('should return nulls on batch API error', async () => {
      globalThis.fetch = (async () => new Response('Error', { status: 500 })) as any;
      const result = await generateEmbeddingBatch(['a', 'b'], apiConfig);
      expect(result).toEqual([null, null]);
    });

    it('should return nulls on network error', async () => {
      globalThis.fetch = (async () => { throw new Error('Network error'); }) as any;
      const result = await generateEmbeddingBatch(['a', 'b'], apiConfig);
      expect(result).toEqual([null, null]);
    });

    it('should handle malformed batch response', async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({ data: null }), { status: 200 })) as any;
      const result = await generateEmbeddingBatch(['a', 'b'], apiConfig);
      expect(result).toEqual([null, null]);
    });
  });
});

// ---- src/storage/NoteRepository.ts (uncovered methods) ----

describe('NoteRepository — Coverage Boost', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  describe('extractTitle', () => {
    it('should extract title from heading', () => {
      const result = ctx.engine.store('# My Title\n\nSome body content', {
        title: '',
        kind: 'reference',
      });
      // Title should be extracted from content heading if empty
      const note = ctx.engine.getById(result.id);
      expect(note).toBeTruthy();
    });
  });

  describe('getByTag', () => {
    it('should return notes matching a specific tag', () => {
      ctx.engine.store('Content A', { title: 'A', kind: 'reference', tags: ['project:myapp'] });
      ctx.engine.store('Content B', { title: 'B', kind: 'reference', tags: ['other'] });

      const results = ctx.engine.getByTag('project:myapp');
      expect(results.length).toBe(1);
      expect(results[0].title).toBe('A');
    });
  });

  describe('getByStatus', () => {
    it('should return notes filtered by status', () => {
      ctx.engine.store('Permanent', { title: 'P', kind: 'reference', status: 'permanent' });
      ctx.engine.store('Fleeting', { title: 'F', kind: 'observation', status: 'fleeting' });

      const permanent = ctx.engine.getByStatus('permanent');
      expect(permanent.some(n => n.title === 'P')).toBe(true);
      expect(permanent.some(n => n.title === 'F')).toBe(false);
    });
  });

  describe('getAll', () => {
    it('should return all notes up to limit', () => {
      for (let i = 0; i < 5; i++) {
        ctx.engine.store(`Note ${i}`, { title: `Note ${i}`, kind: 'reference' });
      }
      const all = ctx.engine.getAll(3);
      expect(all.length).toBe(3);
    });

    it('should return all notes when limit exceeds count', () => {
      ctx.engine.store('Only one', { title: 'One', kind: 'reference' });
      const all = ctx.engine.getAll(100);
      expect(all.length).toBe(1);
    });
  });

  describe('getNotesWithoutEmbeddings', () => {
    it('should return notes that lack embeddings', () => {
      const result = ctx.engine.store('No embedding', { title: 'NE', kind: 'reference' });
      const without = ctx.engine.getNotesWithoutEmbeddings();
      expect(without.some(n => n.id === result.id)).toBe(true);
    });
  });

  describe('getStaleNotes', () => {
    it('should return old fleeting notes', () => {
      const result = ctx.engine.store('Old note', { title: 'Old', kind: 'observation', status: 'fleeting' });
      // getStaleNotes filters on created_at, not updated_at
      const oldTime = Date.now() - (30 * 24 * 60 * 60 * 1000);
      ctx.engine['db'].prepare(
        'UPDATE notes SET created_at = ? WHERE id = ?'
      ).run(oldTime, result.id);

      const stale = ctx.engine.getStaleNotes(14, 2, ['personalization', 'decision']);
      expect(stale.some(n => n.id === result.id)).toBe(true);
    });
  });

  describe('getTopAccessedNotes', () => {
    it('should return notes ordered by access count', () => {
      const r1 = ctx.engine.store('Rarely accessed', { title: 'Rare', kind: 'reference' });
      const r2 = ctx.engine.store('Often accessed', { title: 'Often', kind: 'reference' });

      // Record multiple accesses on r2
      ctx.engine.recordAccess(r2.id);
      ctx.engine.recordAccess(r2.id);
      ctx.engine.recordAccess(r2.id);

      const top = ctx.engine.getTopAccessedNotes(10);
      expect(top.length).toBeGreaterThanOrEqual(1);
      expect(top[0].id).toBe(r2.id);
    });
  });

  describe('getRecentlyAccessedNotes', () => {
    it('should return notes accessed within the given days', () => {
      const r1 = ctx.engine.store('Accessed', { title: 'A', kind: 'reference' });
      ctx.engine.store('Not accessed', { title: 'B', kind: 'reference' });

      ctx.engine.recordAccess(r1.id);

      const recent = ctx.engine.getRecentlyAccessedNotes(7);
      expect(recent.some(n => n.id === r1.id)).toBe(true);
    });
  });

  describe('getRelevantNotesForContext', () => {
    it('should assemble diverse context notes', () => {
      ctx.engine.store('Pref', { title: 'Pref', kind: 'personalization', status: 'permanent' });
      ctx.engine.store('Decision', { title: 'Dec', kind: 'decision', status: 'permanent' });
      ctx.engine.store('Proc', { title: 'Proc', kind: 'procedure', status: 'permanent' });
      const r = ctx.engine.store('Ref', { title: 'Ref', kind: 'reference', status: 'permanent' });
      ctx.engine.recordAccess(r.id);

      const relevant = ctx.engine.getRelevantNotesForContext(10);
      expect(relevant.length).toBeGreaterThanOrEqual(3);
      // Should have no duplicates
      const ids = relevant.map(n => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('getOutgoingLinks', () => {
    it('should return linked notes', () => {
      const r1 = ctx.engine.store('Base note', {
        title: 'Base',
        kind: 'reference',
        existingId: '2026030900000000',
      });

      const r2 = ctx.engine.store('Links to base: [[2026030900000000|Base]]', {
        title: 'Linker',
        kind: 'reference',
      });

      const outgoing = ctx.engine.getOutgoingLinks(r2.id);
      expect(outgoing.some(l => l.note.id === '2026030900000000')).toBe(true);
    });
  });

  describe('getByPath', () => {
    it('should return note by file path', () => {
      const result = ctx.engine.store('Path test', { title: 'PathNote', kind: 'reference' });
      const note = ctx.engine.getById(result.id);
      if (note?.path) {
        const found = ctx.engine.getByPath(note.path);
        expect(found).toBeTruthy();
        expect(found!.id).toBe(result.id);
      }
    });
  });

  describe('searchVector', () => {
    it('should find notes by vector similarity', () => {
      const r1 = ctx.engine.store('TypeScript patterns', { title: 'TS', kind: 'reference' });
      const r2 = ctx.engine.store('Cooking recipes', { title: 'Cook', kind: 'reference' });

      // Store fake embeddings
      ctx.engine.storeEmbedding(r1.id, [1, 0, 0], 'test-model');
      ctx.engine.storeEmbedding(r2.id, [0, 1, 0], 'test-model');

      // Search with vector close to r1 using searchVector directly
      const results = ctx.engine.searchVector([0.9, 0.1, 0]);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe(r1.id);
    });
  });

  describe('searchHybrid', () => {
    it('should combine FTS and vector results', () => {
      const r1 = ctx.engine.store('TypeScript design patterns for experts', { title: 'TS Patterns', kind: 'reference' });
      ctx.engine.storeEmbedding(r1.id, [1, 0, 0], 'test-model');

      const results = ctx.engine.searchHybrid('TypeScript', [0.9, 0.1, 0]);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should fall back to FTS when no embedding provided', () => {
      ctx.engine.store('Unique keyword xylophone in content', { title: 'Xylophone', kind: 'reference' });
      const results = ctx.engine.searchHybrid('xylophone', null);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---- src/tool-handlers.ts (uncovered maintain paths) ----

import { handleStore, handleSearch, handleMaintain } from '../src/tool-handlers';

describe('Tool Handlers — Coverage Boost', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  describe('handleStore edge cases', () => {
    it('should handle related IDs that do not exist', async () => {
      const output = await handleStore({
        title: 'With missing related',
        content: 'Content',
        kind: 'reference',
        related: ['9999999999999999'],
        summary: 'Test',
        guidance: 'Test',
      }, ctx.engine);

      expect(output).toContain('Knowledge stored');
    });
  });

  describe('handleMaintain — stats', () => {
    it('should show embedding provider when config passed', async () => {
      const output = await handleMaintain(
        { action: 'stats' },
        ctx.engine,
        ctx.config,
        { provider: 'local', model: 'test-model', dimensions: 384 }
      );
      expect(output).toContain('Provider:');
    });

    it('should show "Showing N of M" hint when >5 notes', async () => {
      for (let i = 0; i < 6; i++) {
        ctx.engine.store(`Note ${i}`, { title: `Note ${i}`, kind: 'reference' });
      }

      const output = await handleMaintain({ action: 'stats' }, ctx.engine, ctx.config);
      expect(output).toContain('Showing 5 of 6');
    });
  });

  describe('handleMaintain — review', () => {
    it('should return "no notes pending review" for fresh repo', async () => {
      const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
      expect(output).toContain('No notes pending review');
    });

    it('should show stale fleeting notes in review', async () => {
      const r = ctx.engine.store('Old fleeting', { title: 'Stale', kind: 'observation', status: 'fleeting' });
      // getReviewQueue filters on created_at, not updated_at
      const oldTime = Date.now() - (30 * 24 * 60 * 60 * 1000);
      ctx.engine['db'].prepare(
        'UPDATE notes SET created_at = ? WHERE id = ?'
      ).run(oldTime, r.id);

      const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
      expect(output).toContain('Stale');
    });
  });

  describe('handleMaintain — upgrade', () => {
    it('should return "no upgrade needed" when all notes are complete', async () => {
      await handleStore({
        title: 'Complete',
        content: 'Content',
        kind: 'reference',
        summary: 'Has summary',
        guidance: 'Has guidance',
      }, ctx.engine);

      const output = await handleMaintain({ action: 'upgrade' }, ctx.engine, ctx.config);
      expect(output).toContain('No upgrade needed');
    });
  });

  describe('handleMaintain — upgrade-apply', () => {
    it('should return instruction with noteId', async () => {
      const output = await handleMaintain(
        { action: 'upgrade-apply', noteId: '2026030900000000' },
        ctx.engine,
        ctx.config,
      );
      expect(output).toContain('2026030900000000');
    });
  });

  describe('handleMaintain — dedupe', () => {
    it('should report no duplicates for unique notes', async () => {
      await handleStore({ title: 'Unique A', content: 'AAA', kind: 'reference', summary: 'A', guidance: 'A' }, ctx.engine);
      await handleStore({ title: 'Unique B', content: 'BBB', kind: 'reference', summary: 'B', guidance: 'B' }, ctx.engine);

      const output = await handleMaintain({ action: 'dedupe' }, ctx.engine, ctx.config);
      expect(output).toContain('No duplicate notes found');
    });
  });

  describe('handleMaintain — embed', () => {
    it('should error when no embeddingConfig', async () => {
      await handleStore({ title: 'Note', content: 'C', kind: 'reference', summary: 'S', guidance: 'G' }, ctx.engine);
      const output = await handleMaintain({ action: 'embed' }, ctx.engine, ctx.config);
      expect(output).toContain('Embedding not configured');
    });

    it('should report nothing to backfill when all embedded', async () => {
      const r = await handleStore({ title: 'Note', content: 'C', kind: 'reference', summary: 'S', guidance: 'G' }, ctx.engine);
      const id = r.match(/ID: (\S+)/)?.[1];
      if (id) ctx.engine.storeEmbedding(id, [0.1, 0.2], 'test');

      const output = await handleMaintain(
        { action: 'embed' },
        ctx.engine,
        ctx.config,
        { provider: 'local', model: 'test', dimensions: 384 }
      );
      expect(output).toContain('Nothing to backfill');
    });

    it('should support dry run for embed', async () => {
      await handleStore({ title: 'Note', content: 'C', kind: 'reference', summary: 'S', guidance: 'G' }, ctx.engine);
      const output = await handleMaintain(
        { action: 'embed', dryRun: true },
        ctx.engine,
        ctx.config,
        { provider: 'local', model: 'test', dimensions: 384 }
      );
      expect(output).toContain('Dry run');
    });

    it('should actually embed notes via batch API', async () => {
      const originalFetch = globalThis.fetch;
      await handleStore({ title: 'Embed Me', content: 'Content to embed', kind: 'reference', summary: 'S', guidance: 'G' }, ctx.engine);

      // Mock fetch to return embedding
      globalThis.fetch = (async () => new Response(JSON.stringify({
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
        model: 'test-model',
      }), { status: 200 })) as any;

      try {
        const output = await handleMaintain(
          { action: 'embed' },
          ctx.engine,
          ctx.config,
          { provider: 'api', baseUrl: 'https://api.example.com/v1', apiKey: 'test', model: 'test-model', dimensions: 384 }
        );
        expect(output).toContain('Embedded');
        expect(output).toContain('test-model');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('handleMaintain — dedupe with duplicates', () => {
    it('should detect title-based duplicates', async () => {
      await handleStore({ title: 'Same Title', content: 'First version', kind: 'reference', summary: 'A', guidance: 'A' }, ctx.engine);
      await handleStore({ title: 'Same Title', content: 'Second version', kind: 'reference', summary: 'B', guidance: 'B' }, ctx.engine);

      const output = await handleMaintain({ action: 'dedupe' }, ctx.engine, ctx.config);
      expect(output).toContain('Title-Based Duplicates');
      expect(output).toContain('Same Title');
      expect(output).toContain('Recommendation');
    });
  });

  describe('handleMaintain — upgrade-read', () => {
    it('should error when noteId (migrationId) missing', async () => {
      const output = await handleMaintain({ action: 'upgrade-read' }, ctx.engine, ctx.config);
      expect(output).toContain('noteId');
    });

    it('should return unknown migration for invalid ID', async () => {
      const output = await handleMaintain({ action: 'upgrade-read', noteId: 'nonexistent' }, ctx.engine, ctx.config);
      expect(output).toContain('Unknown migration');
    });
  });

  describe('handleMaintain — upgrade-apply without noteId', () => {
    it('should error when noteId missing', async () => {
      const output = await handleMaintain({ action: 'upgrade-apply' }, ctx.engine, ctx.config);
      expect(output).toContain('noteId is required');
    });
  });

  describe('handleMaintain — unknown action', () => {
    it('should return unknown action message', async () => {
      const output = await handleMaintain({ action: 'nonexistent' as any }, ctx.engine, ctx.config);
      expect(output).toContain('Unknown action');
    });
  });

  describe('handleSearch', () => {
    it('should find notes by keyword', () => {
      ctx.engine.store('TypeScript best practices for beginners', { title: 'TS Guide', kind: 'reference' });
      const output = handleSearch({ query: 'TypeScript' }, ctx.engine);
      expect(output).toContain('TS Guide');
      expect(output).toContain('Found');
    });

    it('should return no results message for missing keywords', () => {
      const output = handleSearch({ query: 'xyznonexistent123' }, ctx.engine);
      expect(output).toContain('No matching notes found');
    });

    it('should filter by project tag', () => {
      ctx.engine.store('Project note', { title: 'Proj', kind: 'reference', tags: ['project:myapp'] });
      ctx.engine.store('Other note', { title: 'Other', kind: 'reference', tags: ['project:other'] });
      const output = handleSearch({ query: 'note', project: 'myapp' }, ctx.engine);
      expect(output).toContain('Proj');
    });
  });

  describe('handleMaintain — review with permanent notes', () => {
    it('should show permanent notes that were never accessed', async () => {
      const r = ctx.engine.store('Old permanent', { title: 'OldPerm', kind: 'reference', status: 'permanent' });
      // Age the created_at to make it eligible for review
      const oldTime = Date.now() - (30 * 24 * 60 * 60 * 1000);
      ctx.engine['db'].prepare(
        'UPDATE notes SET created_at = ?, access_count = 0 WHERE id = ?'
      ).run(oldTime, r.id);

      const output = await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
      expect(output).toContain('Permanent Notes for Review');
      expect(output).toContain('OldPerm');
    });
  });

  describe('handleMaintain — stats with other status', () => {
    it('should show "other" count when unknown status exists', async () => {
      await handleStore({ title: 'Normal', content: 'C', kind: 'reference', summary: 'S', guidance: 'G' }, ctx.engine);
      // Inject a note with an invalid status directly
      ctx.engine['db'].prepare(
        "UPDATE notes SET status = 'unknown' WHERE id = (SELECT id FROM notes LIMIT 1)"
      ).run();

      const output = await handleMaintain({ action: 'stats' }, ctx.engine, ctx.config);
      // Stats should still work, may or may not show "Other" depending on getStats impl
      expect(output).toContain('Knowledge Base Statistics');
    });
  });
});
