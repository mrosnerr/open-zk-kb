// embeddings.ts - Generic OpenAI-compatible embedding client
// Supports any provider: OpenRouter, OpenAI, local LM Studio, Ollama OpenAI-compat, etc.
// Falls back gracefully when no provider is configured.

import { logToFile } from './logger.js';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

export interface EmbeddingConfig {
  provider: 'local' | 'api';
  localModel?: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  dimensions: number;
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  provider: 'local',
  localModel: 'Xenova/all-MiniLM-L6-v2',
  model: 'all-MiniLM-L6-v2',
  dimensions: 384,
};

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  tokenCount: number;
}

let localPipeline: FeatureExtractionPipeline | null = null;
let localPipelineLoading: Promise<FeatureExtractionPipeline | null> | null = null;
let loadedModelName: string | null = null;

function getModelCacheDir(): string {
  const xdgCache = process.env.XDG_CACHE_HOME || (
    process.env.HOME ? `${process.env.HOME}/.cache` : '/tmp'
  );
  return `${xdgCache}/open-zk-kb/models`;
}

async function getLocalPipeline(modelName: string): Promise<FeatureExtractionPipeline | null> {
  if (localPipeline && loadedModelName === modelName) return localPipeline;
  if (localPipelineLoading && loadedModelName === modelName) return localPipelineLoading;

  loadedModelName = modelName;
  localPipelineLoading = (async () => {
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = getModelCacheDir();
      localPipeline = await pipeline('feature-extraction', modelName, { dtype: 'q8' }) as FeatureExtractionPipeline;
      logToFile('INFO', 'Local embedding model loaded', { model: modelName, cacheDir: env.cacheDir });
      return localPipeline;
    } catch (error) {
      logToFile('ERROR', 'Failed to load local embedding model', {
        model: modelName,
        error: error instanceof Error ? error.message : String(error),
      });
      localPipelineLoading = null;
      return null;
    }
  })();

  return localPipelineLoading;
}

function hasApiCredentials(config: EmbeddingConfig): config is EmbeddingConfig & { provider: 'api'; baseUrl: string; apiKey: string } {
  return config.provider === 'api' && !!config.baseUrl && !!config.apiKey;
}

async function generateLocalEmbedding(text: string, config: EmbeddingConfig): Promise<EmbeddingResult | null> {
  const pipe = await getLocalPipeline(config.localModel || 'Xenova/all-MiniLM-L6-v2');
  if (!pipe) return null;

  try {
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    const embedding = Array.from(output.data as Float32Array);
    return {
      embedding,
      model: config.model,
      tokenCount: 0,
    };
  } catch (error) {
    logToFile('ERROR', 'Local embedding generation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function generateLocalEmbeddingBatch(texts: string[], config: EmbeddingConfig): Promise<(EmbeddingResult | null)[]> {
  const pipe = await getLocalPipeline(config.localModel || 'Xenova/all-MiniLM-L6-v2');
  if (!pipe) return texts.map(() => null);

  try {
    const output = await pipe(texts, { pooling: 'mean', normalize: true });
    const results: (EmbeddingResult | null)[] = [];
    const embeddings = output.tolist() as number[][];
    for (const embedding of embeddings) {
      results.push({
        embedding,
        model: config.model,
        tokenCount: 0,
      });
    }
    return results;
  } catch (error) {
    logToFile('ERROR', 'Local batch embedding failed', {
      error: error instanceof Error ? error.message : String(error),
      batchSize: texts.length,
    });
    return texts.map(() => null);
  }
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
  if (config.provider === 'local') {
    return generateLocalEmbedding(text, config);
  }

  if (!hasApiCredentials(config)) {
    logToFile('ERROR', 'Embeddings: missing API embedding configuration', {
      model: config.model,
      provider: config.provider,
    });
    return null;
  }

  const apiConfig = config;
  const url = `${apiConfig.baseUrl.replace(/\/+$/, '')}/embeddings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: apiConfig.model,
        input: text,
        ...(apiConfig.dimensions ? { dimensions: apiConfig.dimensions } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logToFile('ERROR', 'Embeddings: API error', {
        status: response.status,
        body: body.slice(0, 500),
        model: apiConfig.model,
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
      model: data.model || apiConfig.model,
      tokenCount: data.usage?.prompt_tokens || 0,
    };
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    logToFile('ERROR', 'Embeddings: call failed', {
      error: error instanceof Error ? error.message : String(error),
      timedOut: isAbort,
      model: apiConfig.model,
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
  if (config.provider === 'local') {
    return generateLocalEmbeddingBatch(texts, config);
  }

  if (!hasApiCredentials(config)) {
    logToFile('ERROR', 'Embeddings: missing API batch embedding configuration', {
      model: config.model,
      provider: config.provider,
      batchSize: texts.length,
    });
    return texts.map(() => null);
  }

  const apiConfig = config;
  if (texts.length === 1) {
    const result = await generateEmbedding(texts[0], apiConfig, timeoutMs);
    return [result];
  }

  const url = `${apiConfig.baseUrl.replace(/\/+$/, '')}/embeddings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: apiConfig.model,
        input: texts,
        ...(apiConfig.dimensions ? { dimensions: apiConfig.dimensions } : {}),
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
        model: data.model || apiConfig.model,
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
