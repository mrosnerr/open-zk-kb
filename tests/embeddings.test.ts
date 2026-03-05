import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  cosineSimilarity,
  embeddingToBlob,
  blobToEmbedding,
  buildEmbeddingText,
} from '../src/embeddings.js';

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(1.0);
  });

  it('returns 1.0 for identical non-unit vectors', () => {
    const a = [3, 4];
    const b = [3, 4];
    expect(cosineSimilarity(a, b)).toBe(1.0);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBe(0.0);
  });

  it('returns -1.0 for opposite vectors', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(-1.0);
  });

  it('returns 0 for vectors of different lengths', () => {
    const a = [1, 0, 0];
    const b = [1, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    const a: number[] = [];
    const b: number[] = [];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 when one vector is empty', () => {
    const a = [1, 2, 3];
    const b: number[] = [];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('returns 0 when one vector is zero', () => {
    const a = [1, 2, 3];
    const b = [0, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('computes correct similarity for known unit vectors', () => {
    const a = [1, 0];
    const b = [0.707, 0.707];
    const result = cosineSimilarity(a, b);
    expect(result).toBeCloseTo(0.707, 2);
  });

  it('computes correct similarity for arbitrary vectors', () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    const result = cosineSimilarity(a, b);
    const expected = (1 * 4 + 2 * 5 + 3 * 6) / (Math.sqrt(14) * Math.sqrt(77));
    expect(result).toBeCloseTo(expected, 5);
  });
});

describe('embeddingToBlob and blobToEmbedding', () => {
  it('round-trips a simple embedding', () => {
    const original = [0.1, 0.2, 0.3, 0.4];
    const blob = embeddingToBlob(original);
    const recovered = blobToEmbedding(blob);
    expect(recovered.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('round-trips an empty embedding', () => {
    const original: number[] = [];
    const blob = embeddingToBlob(original);
    const recovered = blobToEmbedding(blob);
    expect(recovered.length).toBe(0);
  });

  it('round-trips a single-element embedding', () => {
    const original = [42.5];
    const blob = embeddingToBlob(original);
    const recovered = blobToEmbedding(blob);
    expect(recovered.length).toBe(1);
    expect(recovered[0]).toBeCloseTo(42.5, 5);
  });

  it('round-trips a large embedding (1536 dimensions)', () => {
    const original = new Array(1536).fill(0).map((_, i) => Math.sin(i * 0.1));
    const blob = embeddingToBlob(original);
    const recovered = blobToEmbedding(blob);
    expect(recovered.length).toBe(1536);
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('handles negative values correctly', () => {
    const original = [-0.5, -1.0, 0.5, 1.0];
    const blob = embeddingToBlob(original);
    const recovered = blobToEmbedding(blob);
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('accepts Uint8Array as input to blobToEmbedding', () => {
    const original = [1.5, 2.5, 3.5];
    const blob = embeddingToBlob(original);
    const uint8 = new Uint8Array(blob);
    const recovered = blobToEmbedding(uint8);
    expect(recovered.length).toBe(3);
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('produces correct buffer size (4 bytes per float)', () => {
    const original = [1, 2, 3, 4, 5];
    const blob = embeddingToBlob(original);
    expect(blob.length).toBe(original.length * 4);
  });
});

describe('buildEmbeddingText', () => {
  it('joins all three parts with double newlines when all populated', () => {
    const result = buildEmbeddingText('Title', 'Summary', 'Content');
    expect(result).toBe('Title\n\nSummary\n\nContent');
  });

  it('omits empty summary', () => {
    const result = buildEmbeddingText('Title', '', 'Content');
    expect(result).toBe('Title\n\nContent');
  });

  it('omits empty title', () => {
    const result = buildEmbeddingText('', 'Summary', 'Content');
    expect(result).toBe('Summary\n\nContent');
  });

  it('omits empty content', () => {
    const result = buildEmbeddingText('Title', 'Summary', '');
    expect(result).toBe('Title\n\nSummary');
  });

  it('returns empty string when all parts are empty', () => {
    const result = buildEmbeddingText('', '', '');
    expect(result).toBe('');
  });

  it('returns only title when summary and content are empty', () => {
    const result = buildEmbeddingText('Title', '', '');
    expect(result).toBe('Title');
  });

  it('returns only summary when title and content are empty', () => {
    const result = buildEmbeddingText('', 'Summary', '');
    expect(result).toBe('Summary');
  });

  it('returns only content when title and summary are empty', () => {
    const result = buildEmbeddingText('', '', 'Content');
    expect(result).toBe('Content');
  });

  it('truncates content at 8000 characters', () => {
    const longContent = 'x'.repeat(10000);
    const result = buildEmbeddingText('Title', 'Summary', longContent);
    const expectedContent = 'x'.repeat(8000);
    expect(result).toBe(`Title\n\nSummary\n\n${expectedContent}`);
  });

  it('does not truncate content under 8000 characters', () => {
    const content = 'x'.repeat(5000);
    const result = buildEmbeddingText('Title', 'Summary', content);
    expect(result).toBe(`Title\n\nSummary\n\n${content}`);
  });

  it('truncates exactly at 8000 characters', () => {
    const content = 'x'.repeat(8000);
    const result = buildEmbeddingText('Title', 'Summary', content);
    expect(result).toBe(`Title\n\nSummary\n\n${content}`);
  });

  it('truncates content when combined with title and summary', () => {
    const longContent = 'y'.repeat(9000);
    const result = buildEmbeddingText('Title', 'Summary', longContent);
    const expectedContent = 'y'.repeat(8000);
    expect(result).toBe(`Title\n\nSummary\n\n${expectedContent}`);
  });
});
