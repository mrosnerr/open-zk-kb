// embeddings.ts - Generic OpenAI-compatible embedding client
// Supports any provider: OpenRouter, OpenAI, local LM Studio, Ollama OpenAI-compat, etc.
// Falls back gracefully when no provider is configured.

import { logToFile } from './logger.js';

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  tokenCount: number;
}

/**
 * Generate an embedding vector for the given text using an OpenAI-compatible API.
 * Returns null if the call fails (timeout, bad response, etc.) — never throws.
 */
export async function generateEmbedding(
  text: string,
  config: EmbeddingConfig,
  timeoutMs: number = 10000,
): Promise<EmbeddingResult | null> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: text,
        ...(config.dimensions ? { dimensions: config.dimensions } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logToFile('ERROR', 'Embeddings: API error', {
        status: response.status,
        body: body.slice(0, 500),
        model: config.model,
      });
      return null;
    }

    const data = await response.json() as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      model?: string;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };

    const embedding = data.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      logToFile('ERROR', 'Embeddings: unexpected response shape', {
        hasData: !!data.data,
        firstEntry: JSON.stringify(data.data?.[0])?.slice(0, 200),
      });
      return null;
    }

    return {
      embedding,
      model: data.model || config.model,
      tokenCount: data.usage?.prompt_tokens || 0,
    };
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    logToFile('ERROR', 'Embeddings: call failed', {
      error: error instanceof Error ? error.message : String(error),
      timedOut: isAbort,
      model: config.model,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate embeddings for multiple texts in a single API call (batch).
 * Returns null entries for any that fail.
 */
export async function generateEmbeddingBatch(
  texts: string[],
  config: EmbeddingConfig,
  timeoutMs: number = 30000,
): Promise<(EmbeddingResult | null)[]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) {
    const result = await generateEmbedding(texts[0], config, timeoutMs);
    return [result];
  }

  const url = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: texts,
        ...(config.dimensions ? { dimensions: config.dimensions } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logToFile('ERROR', 'Embeddings: batch API error', {
        status: response.status,
        body: body.slice(0, 500),
        batchSize: texts.length,
      });
      return texts.map(() => null);
    }

    const data = await response.json() as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      model?: string;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };

    if (!data.data || !Array.isArray(data.data)) {
      return texts.map(() => null);
    }

    // Sort by index to ensure order matches input
    const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    return sorted.map((entry) => {
      if (!entry.embedding || !Array.isArray(entry.embedding)) return null;
      return {
        embedding: entry.embedding,
        model: data.model || config.model,
        tokenCount: 0, // Per-item tokens not available in batch
      };
    });
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    logToFile('ERROR', 'Embeddings: batch call failed', {
      error: error instanceof Error ? error.message : String(error),
      timedOut: isAbort,
      batchSize: texts.length,
    });
    return texts.map(() => null);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Vector math (pure TS, no native deps) ----

/**
 * Cosine similarity between two vectors. Returns value in [-1, 1].
 * Returns 0 if either vector is zero-length.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

// ---- Serialization helpers ----

export function embeddingToBlob(embedding: number[]): Buffer {
  const buf = Buffer.alloc(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buf.writeFloatLE(embedding[i], i * 4);
  }
  return buf;
}

export function blobToEmbedding(blob: Buffer | Uint8Array): number[] {
  const buf = blob instanceof Buffer ? blob : Buffer.from(blob);
  const count = buf.length / 4;
  const result = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    result[i] = buf.readFloatLE(i * 4);
  }
  return result;
}

/**
 * Build the text to embed for a note.
 * Combines title + summary + content for maximum semantic signal.
 */
export function buildEmbeddingText(title: string, summary: string, content: string): string {
  const parts: string[] = [];
  if (title) parts.push(title);
  if (summary) parts.push(summary);
  if (content) {
    // Truncate content to avoid exceeding token limits (most models: 8K tokens ≈ 30K chars)
    const maxContentChars = 8000;
    parts.push(content.length > maxContentChars ? content.substring(0, maxContentChars) : content);
  }
  return parts.join('\n\n');
}
