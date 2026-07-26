/**
 * Performance benchmarks for open-zk-kb.
 *
 * Validates that core operations stay within acceptable latency/throughput
 * budgets. Each benchmark asserts a generous upper bound so CI catches
 * regressions without being flaky on slow runners.
 *
 * Run:  BENCH=1 bun test tests/benchmarks.test.ts --timeout 60000
 * Skip: bun test  (skipped by default unless BENCH=1)
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { evaluateContextualLinkGraph } from '../src/link-health/evaluator';
import type { ContextualLinkReadResult } from '../src/link-health/types';
import { extractContextualMarkdownFacts } from '../src/markdown/contextual-facts';
import { buildReviewSnapshot } from '../src/review/facts';
import { evaluateGraphReview } from '../src/review/graph';
import type { ReviewReader } from '../src/review/reader';
import { evaluateReview } from '../src/review/registry';
import { NoteRepository, type NoteMetadata } from '../src/storage/NoteRepository';
import { createTestHarness, cleanupTestHarness, type TestContext } from './harness';
import { computeSimHash } from '../src/utils/simhash';
import { extractWikiLinks } from '../src/utils/wikilink';

const BENCH = !!process.env.BENCH;

// ---- Helpers ----

/** Time a sync function, return elapsed ms. */
function timeSync(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/** Time an async function, return elapsed ms. */
async function _timeAsync(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/** Generate realistic note content of varying length. */
function fakeContent(index: number, wordTarget: number = 100): string {
  const topics = ['TypeScript', 'React', 'SQLite', 'Bun', 'MCP', 'Zettelkasten', 'embeddings', 'FTS5'];
  const topic = topics[index % topics.length];
  const words = Array.from({ length: wordTarget }, (_, i) =>
    i % 7 === 0 ? topic : `word${(index * 31 + i) % 500}`
  );
  return words.join(' ');
}

// ---- Benchmarks ----

describe.skipIf(!BENCH)('Performance Benchmarks', () => {

  // =========================================================
  // 1. Startup / Cold Init
  // =========================================================
  describe('Startup', () => {
    it('cold NoteRepository init (empty vault) < 50ms', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bench-init-'));
      try {
        const elapsed = timeSync(() => {
          const repo = new NoteRepository(tempDir);
          repo.close();
        });
        console.log(`  Cold init (empty): ${elapsed.toFixed(2)}ms`);
        expect(elapsed).toBeLessThan(50);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('cold NoteRepository init (existing DB) < 30ms', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bench-init2-'));
      try {
        // First init creates schema
        const repo1 = new NoteRepository(tempDir);
        repo1.store('Seed note', { title: 'Seed', kind: 'reference' });
        repo1.close();

        // Second init should be faster (schema already exists)
        const elapsed = timeSync(() => {
          const repo2 = new NoteRepository(tempDir);
          repo2.close();
        });
        console.log(`  Warm init (existing DB): ${elapsed.toFixed(2)}ms`);
        expect(elapsed).toBeLessThan(30);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================
  // 2. Store Throughput
  // =========================================================
  describe('Store Throughput', () => {
    let ctx: TestContext;
    beforeEach(() => { ctx = createTestHarness(); });
    afterEach(() => { cleanupTestHarness(ctx); });

    it('sequential store: 100 notes < 2s', () => {
      const elapsed = timeSync(() => {
        for (let i = 0; i < 100; i++) {
          ctx.engine.store(fakeContent(i), {
            title: `Note ${i}`,
            kind: 'reference',
            tags: [`bench`, `topic:${i % 5}`],
            summary: `Summary for note ${i}`,
            guidance: `Guidance for note ${i}`,
          });
        }
      });
      const rate = (100 / elapsed) * 1000;
      console.log(`  100 sequential stores: ${elapsed.toFixed(2)}ms (${rate.toFixed(0)} notes/sec)`);
      expect(elapsed).toBeLessThan(2000);
    });

    it('sequential store: 500 notes < 10s', () => {
      const elapsed = timeSync(() => {
        for (let i = 0; i < 500; i++) {
          ctx.engine.store(fakeContent(i, 200), {
            title: `Note ${i}`,
            kind: ['reference', 'observation', 'procedure', 'decision', 'resource', 'personalization'][i % 6] as any,
            tags: [`bench`, `topic:${i % 10}`],
            summary: `Summary ${i}`,
            guidance: `Guidance ${i}`,
          });
        }
      });
      const rate = (500 / elapsed) * 1000;
      console.log(`  500 sequential stores: ${elapsed.toFixed(2)}ms (${rate.toFixed(0)} notes/sec)`);
      expect(elapsed).toBeLessThan(10000);
    });

    it('update existing note < 20ms avg', () => {
      // Create note first
      const result = ctx.engine.store('Original content', {
        title: 'Updatable',
        kind: 'reference',
        summary: 'Original',
        guidance: 'Original',
      });

      // Measure 50 updates
      const elapsed = timeSync(() => {
        for (let i = 0; i < 50; i++) {
          ctx.engine.store(`Updated content v${i}`, {
            title: 'Updatable',
            kind: 'reference',
            summary: `Updated ${i}`,
            guidance: `Updated ${i}`,
            existingId: result.id,
          });
        }
      });
      const avg = elapsed / 50;
      console.log(`  50 updates: ${elapsed.toFixed(2)}ms (${avg.toFixed(2)}ms avg)`);
      expect(avg).toBeLessThan(20);
    });
  });

  // =========================================================
  // 3. Search Latency
  // =========================================================
  describe('Search Latency', () => {
    let ctx: TestContext;

    beforeEach(() => {
      ctx = createTestHarness();
      // Seed 200 notes for search benchmarks
      for (let i = 0; i < 200; i++) {
        ctx.engine.store(fakeContent(i, 150), {
          title: `Note ${i} about ${['TypeScript', 'React', 'SQLite', 'Bun', 'MCP'][i % 5]}`,
          kind: 'reference',
          tags: [`topic:${i % 5}`],
          summary: `Summary for note ${i}`,
          guidance: `Guidance for note ${i}`,
        });
      }
    });
    afterEach(() => { cleanupTestHarness(ctx); });

    it('FTS5 search (200 notes) < 10ms', () => {
      const elapsed = timeSync(() => {
        const results = ctx.engine.search('TypeScript');
        expect(results.length).toBeGreaterThan(0);
      });
      console.log(`  FTS5 search (200 notes): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(10);
    });

    it('FTS5 search with filters < 15ms', () => {
      const elapsed = timeSync(() => {
        ctx.engine.search('React', {
          kind: 'reference',
          tags: ['topic:1'],
          limit: 5,
        });
      });
      console.log(`  FTS5 search w/ filters: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(15);
    });

    it('vector search (200 notes, 384-dim) < 20ms', () => {
      // Seed embeddings (384 dimensions)
      const allNotes = ctx.engine.getAll(200);
      for (const note of allNotes) {
        const embedding = Array.from({ length: 384 }, () => Math.random() * 2 - 1);
        ctx.engine.storeEmbedding(note.id, embedding, 'bench-model');
      }

      const queryVec = Array.from({ length: 384 }, () => Math.random() * 2 - 1);
      const elapsed = timeSync(() => {
        const results = ctx.engine.searchVector(queryVec, { limit: 10 });
        expect(results.length).toBeGreaterThan(0);
      });
      console.log(`  Vector search (200 notes, 384-dim): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(20);
    });

    it('hybrid search (200 notes) < 30ms', () => {
      // Seed embeddings
      const allNotes = ctx.engine.getAll(200);
      for (const note of allNotes) {
        const embedding = Array.from({ length: 384 }, () => Math.random() * 2 - 1);
        ctx.engine.storeEmbedding(note.id, embedding, 'bench-model');
      }

      const queryVec = Array.from({ length: 384 }, () => Math.random() * 2 - 1);
      const elapsed = timeSync(() => {
        const results = ctx.engine.searchHybrid('TypeScript', queryVec, { limit: 10 });
        expect(results.length).toBeGreaterThan(0);
      });
      console.log(`  Hybrid search (200 notes): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(30);
    });

    it('search scales: 10 sequential queries < 50ms total', () => {
      const queries = ['TypeScript', 'React', 'SQLite', 'Bun', 'MCP', 'word100', 'word200', 'word300', 'topic', 'note'];
      const elapsed = timeSync(() => {
        for (const q of queries) {
          ctx.engine.search(q, { limit: 5 });
        }
      });
      console.log(`  10 sequential FTS queries: ${elapsed.toFixed(2)}ms (${(elapsed / 10).toFixed(2)}ms avg)`);
      expect(elapsed).toBeLessThan(50);
    });
  });

  // =========================================================
  // 4. Bulk Operations
  // =========================================================
  describe('Bulk Operations', () => {
    let ctx: TestContext;
    beforeEach(() => { ctx = createTestHarness(); });
    afterEach(() => { cleanupTestHarness(ctx); });

    it('rebuildFromFiles (200 notes) < 2s', () => {
      // Seed 200 notes via store (creates .md files)
      for (let i = 0; i < 200; i++) {
        ctx.engine.store(fakeContent(i, 100), {
          title: `Rebuild Note ${i}`,
          kind: 'reference',
          summary: `Summary ${i}`,
          guidance: `Guidance ${i}`,
        });
      }

      const elapsed = timeSync(() => {
        const result = ctx.engine.rebuildFromFiles();
        expect(result.indexed).toBe(200);
        expect(result.errors).toBe(0);
      });
      console.log(`  rebuildFromFiles (200 notes): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(2000);
    });

    it('storeEmbedding batch (200 notes, 384-dim) < 500ms', () => {
      // Seed notes
      const ids: string[] = [];
      for (let i = 0; i < 200; i++) {
        const r = ctx.engine.store(`Embed note ${i}`, {
          title: `Embed ${i}`,
          kind: 'reference',
        });
        ids.push(r.id);
      }

      const elapsed = timeSync(() => {
        for (const id of ids) {
          const embedding = Array.from({ length: 384 }, () => Math.random() * 2 - 1);
          ctx.engine.storeEmbedding(id, embedding, 'bench-model');
        }
      });
      console.log(`  storeEmbedding x200 (384-dim): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(500);
    });

    it('findDuplicates (200 notes) < 50ms', () => {
      for (let i = 0; i < 200; i++) {
        ctx.engine.store(fakeContent(i), {
          title: `Dup Note ${i % 50}`, // 50 unique titles, 4 copies each
          kind: 'reference',
        });
      }

      const elapsed = timeSync(() => {
        const dupes = ctx.engine.findDuplicates();
        expect(dupes.size).toBeGreaterThan(0);
      });
      console.log(`  findDuplicates (200 notes, ~50 groups): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(50);
    });

    it('findSimHashDuplicates (200 notes) < 100ms', () => {
      for (let i = 0; i < 200; i++) {
        const content = fakeContent(i, 100);
        const result = ctx.engine.store(content, {
          title: `SimHash Note ${i}`,
          kind: 'reference',
          summary: `Summary ${i}`,
        });
        // Backfill content hash
        const hash = computeSimHash(content);
        ctx.engine.updateContentHash(result.id, hash);
      }

      const elapsed = timeSync(() => {
        ctx.engine.findSimHashDuplicates();
        // May or may not find dupes depending on content similarity
      });
      console.log(`  findSimHashDuplicates (200 notes): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(100);
    });

    it('getRelevantNotesForContext (200 notes) < 50ms', () => {
      for (let i = 0; i < 200; i++) {
        const r = ctx.engine.store(fakeContent(i), {
          title: `Context Note ${i}`,
          kind: ['reference', 'personalization', 'decision', 'procedure'][i % 4] as any,
          status: i % 3 === 0 ? 'fleeting' : 'permanent',
          summary: `Summary ${i}`,
          guidance: `Guidance ${i}`,
        });
        if (i % 5 === 0) ctx.engine.recordAccess(r.id);
      }

      const elapsed = timeSync(() => {
        const notes = ctx.engine.getRelevantNotesForContext(20);
        expect(notes.length).toBeGreaterThan(0);
      });
      console.log(`  getRelevantNotesForContext (200 notes): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(50);
    });

    it('getReviewQueue (200 notes) < 30ms', () => {
      for (let i = 0; i < 200; i++) {
        const r = ctx.engine.store(fakeContent(i), {
          title: `Review Note ${i}`,
          kind: 'observation',
          status: 'fleeting',
        });
        // Age half the notes
        if (i % 2 === 0) {
          ctx.engine['db'].prepare('UPDATE notes SET created_at = ? WHERE id = ?')
            .run(Date.now() - (30 * 24 * 60 * 60 * 1000), r.id);
        }
      }

      const elapsed = timeSync(() => {
        const queue = ctx.engine.getReviewQueue(undefined, 14, 10, []);
        expect(queue.fleeting.total).toBeGreaterThan(0);
      });
      console.log(`  getReviewQueue (200 notes): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(30);
    });
  });

  // =========================================================
  // 5. Scale Test (larger vault)
  // =========================================================
  describe('Scale (1000 notes)', () => {
    let ctx: TestContext;

    beforeEach(() => {
      ctx = createTestHarness();
      // Seed 1000 notes
      for (let i = 0; i < 1000; i++) {
        ctx.engine.store(fakeContent(i, 80), {
          title: `Scale Note ${i}`,
          kind: ['reference', 'observation', 'procedure', 'decision'][i % 4] as any,
          tags: [`topic:${i % 20}`],
          summary: `Summary ${i}`,
          guidance: `Guidance ${i}`,
        });
      }
    });
    afterEach(() => { cleanupTestHarness(ctx); });

    it('FTS5 search (1000 notes) < 15ms', () => {
      const elapsed = timeSync(() => {
        const results = ctx.engine.search('TypeScript', { limit: 10 });
        expect(results.length).toBeGreaterThan(0);
      });
      console.log(`  FTS5 search (1000 notes): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(15);
    });

    it('getStats (1000 notes) < 10ms', () => {
      const elapsed = timeSync(() => {
        const stats = ctx.engine.getStats();
        expect(stats.total).toBe(1000);
      });
      console.log(`  getStats (1000 notes): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(10);
    });

    it('getAll with limit (1000 notes) < 20ms', () => {
      const elapsed = timeSync(() => {
        const notes = ctx.engine.getAll(50);
        expect(notes.length).toBe(50);
      });
      console.log(`  getAll(50) from 1000: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(20);
    });

    it('rebuildFromFiles (1000 notes) < 10s', () => {
      const elapsed = timeSync(() => {
        const result = ctx.engine.rebuildFromFiles();
        expect(result.indexed).toBe(1000);
      });
      console.log(`  rebuildFromFiles (1000 notes): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(10000);
    });
  });

  // =========================================================
  // 6. Contextual Markdown extraction
  // =========================================================
  describe('Contextual Markdown Facts', () => {
    it('extracts 1,000 representative notes in-process < 1,500ms', () => {
      const notes = Array.from({ length: 1000 }, (_, index) => [
        '---',
        `related: "[[${String(index).padStart(16, '0')}|Metadata]]"`,
        '---',
        `# Note ${index} [[${String(index + 1000).padStart(16, '0')}|Heading]]`,
        `Authored prose ${fakeContent(index, 80)} [[${String(index + 2000).padStart(16, '0')}#Detail|Detail]].`,
        `Inline \`[[${String(index + 3000).padStart(16, '0')}]]\` example.`,
        '```md',
        `[[${String(index + 4000).padStart(16, '0')}]]`,
        '```',
      ].join('\n'));

      const measure = (): { eligibleText: number; contextualLinks: number; excludedCandidates: number; elapsed: number } => {
        let eligibleText = 0;
        let contextualLinks = 0;
        let excludedCandidates = 0;
        const elapsed = timeSync(() => {
          for (const note of notes) {
            const result = extractContextualMarkdownFacts(note);
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.reason);
            eligibleText += result.textSegments.length;
            contextualLinks += result.wikilinks.length;
            excludedCandidates += extractWikiLinks(note).length - result.wikilinks.length;
          }
        });
        return { eligibleText, contextualLinks, excludedCandidates, elapsed };
      };

      const first = measure();
      const second = measure();
      console.log(`  Contextual Markdown facts (1000 notes): ${first.elapsed.toFixed(2)}ms`);
      expect(first.elapsed).toBeLessThan(1500);
      expect(first.contextualLinks).toBe(2000);
      expect(first.excludedCandidates).toBe(3000);
      expect(first.eligibleText).toBeGreaterThan(0);
      expect(second).toMatchObject({
        eligibleText: first.eligibleText,
        contextualLinks: first.contextualLinks,
        excludedCandidates: first.excludedCandidates,
      });
    });
  });

  describe('Contextual Link Health', () => {
    it('evaluates a 1,000-document authored-link graph in-process < 1,500ms', () => {
      const documents: ContextualLinkReadResult[] = Array.from({ length: 1000 }, (_, index) => {
        const id = String(index).padStart(16, '0');
        const target = String((index + 1) % 1000).padStart(16, '0');
        return {
          document: { id, title: `Graph note ${index}`, kind: 'reference', status: 'fleeting', tags: ['project:bench'] },
          ok: true,
          source: [
            '---', `up: "[[${target}|Navigation]]"`, '---',
            `Authored [[${target}|Next]].`,
            `Inline \`[[${target}|Example]]\` ignored.`,
          ].join('\n'),
        };
      });
      const ids = new Set(documents.map(entry => entry.document.id));
      const resolve = (slug: string): string | null => ids.has(slug) ? slug : null;
      let first = evaluateContextualLinkGraph([], resolve);
      const elapsed = timeSync(() => { first = evaluateContextualLinkGraph(documents, resolve); });
      const second = evaluateContextualLinkGraph(documents, resolve);

      console.log(`  Contextual link health (1000 notes): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(1500);
      expect(first.totals).toEqual({ documentsParsed: 1000, rawCandidates: 3000, contextualLinks: 1000, excludedCandidates: 2000, parseFailures: 0 });
      expect(first.broken).toHaveLength(0);
      expect(first.unlinked).toHaveLength(0);
      expect(first.oneWay).toHaveLength(1000);
      expect(second.totals).toEqual(first.totals);
      expect(second.oneWay).toEqual(first.oneWay);

      // Formal graph-rule evaluation over the same snapshot stays well within
      // budget and produces deterministic totals across repeated runs.
      let firstRules = evaluateGraphReview(first);
      const rulesElapsed = timeSync(() => { firstRules = evaluateGraphReview(first); });
      const secondRules = evaluateGraphReview(first);
      console.log(`  Contextual graph rules (1000 edges): ${rulesElapsed.toFixed(2)}ms`);
      expect(elapsed + rulesElapsed).toBeLessThan(1500);
      expect(firstRules.totals).toEqual({ 'links.broken': 0, 'links.unlinked': 0, 'links.reciprocal-missing': 1000 });
      expect(secondRules.totals).toEqual(firstRules.totals);
      expect(JSON.stringify(secondRules)).toBe(JSON.stringify(firstRules));
    });
  });

  // =========================================================
  // 7. Host-neutral vault review core
  // =========================================================
  describe('Vault Review Core', () => {
    it('materializes and evaluates 1,000 notes in-process < 200ms', () => {
      const now = Date.now();
      const notes: NoteMetadata[] = Array.from({ length: 1000 }, (_, index) => {
        const kind = index % 5 === 0 ? 'personalization' : 'reference';
        const content = index % 5 === 0
          ? `Temporarily configure claude-sonnet routing for /tmp/note-${index}.`
          : fakeContent(index, index % 3 === 0 ? 250 : 100);
        return {
          id: String(index).padStart(16, '0'),
          path: `/vault/${index}.md`,
          title: `Representative review note ${index}`,
          kind,
          status: index % 4 === 0 ? 'permanent' : 'fleeting',
          lifecycle: 'living',
          type: 'atomic',
          tags: ['project:bench'],
          content,
          summary: `Summary ${index}`,
          guidance: `Guidance ${index}`,
          created_at: now - 20 * 86_400_000,
          updated_at: now - index,
          word_count: content.split(/\s+/).length,
          access_count: index % 7,
        };
      });
      const reader: ReviewReader = {
        listNotes: () => notes,
        backlinkCounts: () => new Map(),
      };
      const scope = { kind: 'full' } as const;
      let firstTotals: Readonly<Record<string, number>> = {};
      const elapsed = timeSync(() => {
        const snapshot = buildReviewSnapshot(reader, scope, now);
        firstTotals = evaluateReview({
          scope,
          now,
          policy: { reviewAfterDays: 14, archiveAfterDays: 90, promotionThreshold: 3, exemptKinds: [] },
        }, snapshot).totals;
      });
      const second = evaluateReview({
        scope,
        now,
        policy: { reviewAfterDays: 14, archiveAfterDays: 90, promotionThreshold: 3, exemptKinds: [] },
      }, buildReviewSnapshot(reader, scope, now));

      console.log(`  Vault review core (1000 notes): ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(200);
      expect(second.totals).toEqual(firstTotals);
      expect(Object.values(firstTotals).reduce((sum, count) => sum + count, 0)).toBeGreaterThan(0);
    });
  });
});
