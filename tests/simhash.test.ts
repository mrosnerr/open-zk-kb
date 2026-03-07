import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { computeSimHash, hammingDistance, isNearDuplicate, shingle } from '../src/utils/simhash.js';
import { createTestHarness, cleanupTestHarness } from './harness.js';
import type { TestContext } from './harness.js';

describe('SimHash', () => {
  describe('shingle', () => {
    it('generates 3-gram word shingles', () => {
      const result = shingle('the quick brown fox jumps');
      expect(result).toEqual([
        'the quick brown',
        'quick brown fox',
        'brown fox jumps',
      ]);
    });

    it('handles short text', () => {
      const result = shingle('hello world');
      expect(result).toEqual(['hello world']);
    });

    it('handles single word', () => {
      const result = shingle('hello');
      expect(result).toEqual(['hello']);
    });
  });

  describe('computeSimHash', () => {
    it('returns a 16-char hex string', () => {
      const hash = computeSimHash('some test content for hashing');
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns same hash for same content', () => {
      const hash1 = computeSimHash('identical content here');
      const hash2 = computeSimHash('identical content here');
      expect(hash1).toBe(hash2);
    });

    it('returns different hashes for different content', () => {
      const hash1 = computeSimHash('I prefer tabs over spaces');
      const hash2 = computeSimHash('The architecture uses microservices');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('hammingDistance', () => {
    it('returns 0 for identical hashes', () => {
      const hash = computeSimHash('test content');
      expect(hammingDistance(hash, hash)).toBe(0);
    });

    it('returns small distance for similar content', () => {
      const hash1 = computeSimHash('I prefer tabs over spaces for indentation in all my projects');
      const hash2 = computeSimHash('I prefer tabs over spaces for indentation in every project');
      const distance = hammingDistance(hash1, hash2);
      expect(distance).toBeLessThanOrEqual(10);
    });

    it('returns large distance for unrelated content', () => {
      const hash1 = computeSimHash('I prefer tabs over spaces for indentation in all projects');
      const hash2 = computeSimHash('The microservice architecture requires careful API boundary design and versioning strategy');
      const distance = hammingDistance(hash1, hash2);
      expect(distance).toBeGreaterThan(5);
    });
  });

  describe('isNearDuplicate', () => {
    it('detects identical content as duplicate', () => {
      const hash = computeSimHash('We chose PostgreSQL because of ACID transactions');
      expect(isNearDuplicate(hash, hash)).toBe(true);
    });

    it('detects near-duplicate content', () => {
      const hash1 = computeSimHash('We chose PostgreSQL because of ACID transactions and reliability');
      const hash2 = computeSimHash('We chose PostgreSQL because of ACID transactions and data integrity');
      const distance = hammingDistance(hash1, hash2);
      expect(isNearDuplicate(hash1, hash2, distance)).toBe(true);
    });

    it('rejects clearly different content', () => {
      const hash1 = computeSimHash('Always use TypeScript strict mode for type safety');
      const hash2 = computeSimHash('Deploy using Docker containers with Kubernetes orchestration');
      expect(isNearDuplicate(hash1, hash2, 3)).toBe(false);
    });
  });
});

describe('NoteRepository content hash dedup', () => {
  let context: TestContext;

  beforeEach(() => {
    context = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(context);
  });

  it('stores and finds identical hash matches', () => {
    const original = context.engine.store({
      title: 'PostgreSQL decision',
      content: 'We chose PostgreSQL because of ACID transactions and reliability.',
      kind: 'decision',
    });

    const originalHash = computeSimHash('We chose PostgreSQL because of ACID transactions and reliability.');
    context.engine.updateContentHash(original.id, originalHash);

    const nearDuplicates = context.engine.findNearDuplicates(originalHash, 0);

    expect(nearDuplicates.some((note) => note.id === original.id)).toBe(true);
  });

  it('returns hash inventory with getAllContentHashes', () => {
    const first = context.engine.store({ title: 'First', content: 'Alpha content', kind: 'reference' });
    const second = context.engine.store({ title: 'Second', content: 'Beta content', kind: 'reference' });

    context.engine.updateContentHash(first.id, computeSimHash('Alpha content'));
    context.engine.updateContentHash(second.id, computeSimHash('Beta content'));

    const hashes = context.engine.getAllContentHashes();

    expect(hashes.length).toBe(2);
    expect(hashes.map((h) => h.id)).toContain(first.id);
    expect(hashes.map((h) => h.id)).toContain(second.id);
    for (const entry of hashes) {
      expect(entry.hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
