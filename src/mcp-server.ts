#!/usr/bin/env bun
// mcp-server.ts - MCP stdio server
// Exposes knowledge-store, knowledge-search, knowledge-maintain as MCP tools.
// Stdout is the MCP transport — use logToFile() for all logging.

if (typeof globalThis.Bun === 'undefined') {
  console.error(
    'open-zk-kb requires the Bun runtime (uses bun:sqlite).\n' +
    'Install Bun: https://bun.sh\n' +
    'Then run: bunx open-zk-kb@latest'
  );
  process.exit(1);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getConfig, getEmbeddingsConfig } from './config.js';
import { logToFile } from './logger.js';
import { handleStore, handleSearch, handleMaintain } from './tool-handlers.js';
import { generateEmbedding, DEFAULT_EMBEDDING_CONFIG } from './embeddings.js';
import type { EmbeddingConfig } from './embeddings.js';
import type { NoteKind } from './types.js';
import type { NoteRepository as NoteRepositoryType } from './storage/NoteRepository.js';
import { PKG_VERSION } from './version.js';

const { NoteRepository } = await import('./storage/NoteRepository.js');

const config = getConfig();
let repo: NoteRepositoryType | null = null;

function getOrCreateRepo(): NoteRepositoryType {
  if (!repo) {
    repo = new NoteRepository(config.vault);
    logToFile('INFO', 'MCP server: repository opened', { vault: config.vault }, config);
  }
  return repo;
}

let cachedEmbeddingConfig: EmbeddingConfig | null | undefined;

function getEmbeddingConfig(): EmbeddingConfig | null {
  if (cachedEmbeddingConfig !== undefined) return cachedEmbeddingConfig;

  const embCfg = getEmbeddingsConfig();

  if (embCfg?.enabled === false) {
    cachedEmbeddingConfig = null;
    return null;
  }

  if (embCfg?.provider === 'api' && embCfg.model) {
    const baseUrl = embCfg.base_url;
    const apiKey = embCfg.api_key;
    if (baseUrl && apiKey) {
      cachedEmbeddingConfig = {
        provider: 'api',
        baseUrl,
        apiKey,
        model: embCfg.model,
        dimensions: embCfg.dimensions || 1536,
      };
      return cachedEmbeddingConfig;
    }
  }

  cachedEmbeddingConfig = { ...DEFAULT_EMBEDDING_CONFIG };
  return cachedEmbeddingConfig;
}


const server = new McpServer({
  name: 'open-zk-kb',
  version: PKG_VERSION,
});

// ---- knowledge-store ----

const NOTE_KINDS = ['personalization', 'reference', 'decision', 'procedure', 'resource', 'observation'] as const;

const storeSchema = z.object({
  title: z.string().describe('Note title — concise, descriptive'),
  content: z.string().describe('Note content — the knowledge to store'),
  kind: z.enum(NOTE_KINDS).describe('Note kind: personalization, reference, decision, procedure, resource, observation'),
  status: z.enum(['fleeting', 'permanent', 'archived']).optional().describe('Override default status (defaults based on kind)'),
  tags: z.array(z.string()).optional().describe('Tags for categorization'),
  summary: z.string().describe('One-line present-tense key takeaway'),
  guidance: z.string().describe('Imperative actionable instruction for agents'),
  project: z.string().optional().describe('Project scope — auto-adds project:<name> tag'),
  client: z.string().optional().describe('Client identifier (e.g. claude-code, opencode). Auto-detected from content when omitted.'),
  related: z.array(z.string()).optional().describe('IDs of related notes to link via wikilinks'),
});

server.registerTool(
  'knowledge-store',
  {
    description: 'Store knowledge in the persistent Zettelkasten knowledge base. One concept per note.',
    inputSchema: storeSchema as any,
  },
  async (args: z.infer<typeof storeSchema>) => {
    try {
      const result = handleStore({
        title: args.title,
        content: args.content,
        kind: args.kind as NoteKind,
        status: args.status,
        tags: args.tags,
        summary: args.summary,
        guidance: args.guidance,
        project: args.project,
        client: args.client,
        related: args.related,
      }, getOrCreateRepo(), getEmbeddingConfig());
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (error) {
      logToFile('ERROR', 'knowledge-store failed', {
        error: error instanceof Error ? error.message : String(error),
      }, config);
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// ---- knowledge-search ----

/** Race embedding generation against a timeout. Returns null if not ready in time. */
async function tryEmbedding(text: string, embConfig: EmbeddingConfig, timeoutMs: number): Promise<number[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      generateEmbedding(text, embConfig),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    return result?.embedding || null;
  } catch (err) {
    logToFile('DEBUG', 'Embedding generation failed', { error: String(err) }, config);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const searchSchema = z.object({
  query: z.string().describe('Search query — natural language or keywords. Supports semantic matching when embeddings are enabled.'),
  kind: z.enum(NOTE_KINDS).optional().describe('Filter by note kind'),
  status: z.enum(['fleeting', 'permanent', 'archived']).optional().describe('Filter by status'),
  project: z.string().optional().describe('Filter by project tag'),
  client: z.string().optional().describe('Your client name — excludes notes scoped to other clients'),
  tags: z.array(z.string()).optional().describe('Filter by tags (all must match)'),
  limit: z.number().optional().describe('Max results (default 10)'),
});

server.registerTool(
  'knowledge-search',
  {
    description: 'Search the persistent knowledge base using full-text search and semantic similarity. Accepts natural language queries, keywords, or phrases. Returns matching notes with full content.',
    inputSchema: searchSchema as any,
  },
  async (args: z.infer<typeof searchSchema>) => {
    try {
      const embConfig = getEmbeddingConfig();

      // Attempt embedding with 500ms timeout — returns FTS5-only results if model not ready
      const queryEmbedding = embConfig
        ? await tryEmbedding(args.query, embConfig, 500)
        : null;

      const result = handleSearch({
        query: args.query,
        kind: args.kind as NoteKind | undefined,
        status: args.status,
        project: args.project,
        client: args.client,
        tags: args.tags,
        limit: args.limit,
      }, getOrCreateRepo(), queryEmbedding);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (error) {
      logToFile('ERROR', 'knowledge-search failed', {
        error: error instanceof Error ? error.message : String(error),
      }, config);
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// ---- knowledge-maintain ----

const maintainSchema = z.object({
  action: z.enum(['stats', 'promote', 'archive', 'delete', 'rebuild', 'upgrade', 'upgrade-read', 'upgrade-apply', 'review', 'dedupe', 'embed', 'agent-docs', 'scope-audit'])
    .describe('Maintenance action: stats, review (pending notes), dedupe (duplicates), promote, archive, delete, rebuild, upgrade, embed (backfill embeddings), agent-docs (audit/repair managed agent instruction files), scope-audit (detect mis-scoped client tags)'),
  noteId: z.string().optional().describe('Note ID (required for promote/archive/delete; migration ID for upgrade-read)'),
  filter: z.enum(['fleeting', 'permanent']).optional().describe('Filter for review action: fleeting or permanent notes'),
  days: z.number().optional().describe('Days threshold for review (default: from lifecycle.reviewAfterDays config)'),
  limit: z.number().optional().describe('Max notes to show (default: 3 for review)'),
  dryRun: z.boolean().optional().describe('Preview changes without applying'),
});

server.registerTool(
  'knowledge-maintain',
  {
    description: 'Maintain the knowledge base: stats, review (pending notes), dedupe (duplicates), promote, archive, delete, rebuild, upgrade, and managed agent docs repair.',
    inputSchema: maintainSchema as any,
  },
  async (args: z.infer<typeof maintainSchema>) => {
    try {
      const result = await handleMaintain({
        action: args.action,
        noteId: args.noteId,
        filter: args.filter as 'fleeting' | 'permanent' | undefined,
        days: args.days,
        limit: args.limit,
        dryRun: args.dryRun,
      }, getOrCreateRepo(), config, getEmbeddingConfig(), PKG_VERSION);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (error) {
      logToFile('ERROR', 'knowledge-maintain failed', {
        error: error instanceof Error ? error.message : String(error),
      }, config);
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// ---- Startup ----

export async function startServer() {
  ensureShutdownHandlers();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logToFile('INFO', 'MCP server: connected via stdio', {}, config);

  // Warm up embedding model in background so first search gets semantic results
  const embConfig = getEmbeddingConfig();
  if (embConfig) {
    generateEmbedding('warmup', embConfig).catch(() => {
      // Non-fatal — search falls back to FTS5-only
    });
  }
}

function shutdown() {
  logToFile('INFO', 'MCP server: shutting down', {}, config);
  if (repo) {
    try {
      repo.close();
    } catch (error) {
      logToFile('WARN', 'MCP server: failed to close repository', {
        error: error instanceof Error ? error.message : String(error),
      }, config);
    }
  }
  process.exit(0);
}

let shutdownHandlersRegistered = false;

function ensureShutdownHandlers() {
  if (shutdownHandlersRegistered) return;
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  shutdownHandlersRegistered = true;
}

if (import.meta.main) {
  startServer().catch((error) => {
    logToFile('ERROR', 'MCP server: startup failed', {
      error: error instanceof Error ? error.message : String(error),
    }, config);
    process.exit(1);
  });
}
