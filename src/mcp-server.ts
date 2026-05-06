#!/usr/bin/env bun
// mcp-server.ts - MCP stdio server
// Exposes knowledge-store, knowledge-search, knowledge-mine, knowledge-maintain as MCP tools.
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
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { getConfig, getEmbeddingsConfig } from './config.js';
import { logToFile } from './logger.js';
import { ensureObsidianScaffold } from './obsidian-scaffold.js';
import { handleStore, handleSearch, handleMaintain, handleIngest, handleOverview, handleOpen, handleMine, handleTemplate } from './tool-handlers.js';
import { generateEmbedding, DEFAULT_EMBEDDING_CONFIG } from './embeddings.js';
import type { EmbeddingConfig } from './embeddings.js';
import type { NoteKind } from './types.js';
import type { NoteRepository as NoteRepositoryType } from './storage/NoteRepository.js';
import { PKG_VERSION } from './version.js';

const { NoteRepository } = await import('./storage/NoteRepository.js');

const config = getConfig();
let repo: NoteRepositoryType | null = null;
let repoInitPromise: Promise<NoteRepositoryType> | null = null;

async function getOrCreateRepo(): Promise<NoteRepositoryType> {
  if (repo) return repo;
  if (repoInitPromise) return repoInitPromise;

  repoInitPromise = (async () => {
    const instance = new NoteRepository(config.vault, { telemetryEnabled: config.telemetry.enabled });
    repo = instance;
    logToFile('INFO', 'MCP server: repository opened', { vault: config.vault }, config);

    const obsidianDir = path.join(config.vault, '.obsidian');
    if (config.obsidian.autoUpgrade && fs.existsSync(obsidianDir)) {
      try {
        await ensureObsidianScaffold(config.vault, config.obsidian);
      } catch (error) {
        logToFile('WARN', 'Failed to auto-upgrade Obsidian scaffold on server init', {
          error: error instanceof Error ? error.message : String(error),
          vault: config.vault,
        }, config);
      }
    }

    return instance;
  })();

  try {
    return await repoInitPromise;
  } catch (error) {
    repo = null;
    repoInitPromise = null;
    throw error;
  }
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

const NOTE_KINDS = ['personalization', 'reference', 'decision', 'procedure', 'resource', 'observation', 'domain', 'index', 'log'] as const;
const STORABLE_KINDS = ['personalization', 'reference', 'decision', 'procedure', 'resource', 'observation', 'domain'] as const;
const LIFECYCLES = ['living', 'snapshot', 'append-only'] as const;

const storeSchema = z.object({
  title: z.string().describe('Note title — 3-6 word scannable label (max 10 words / 80 chars). Detail belongs in summary.'),
  content: z.string().describe('Note content — the knowledge to store'),
  kind: z.enum(STORABLE_KINDS).describe('Note kind: personalization, reference, decision, procedure, resource, observation, domain'),
  status: z.enum(['fleeting', 'permanent', 'archived']).optional().describe('Override default status (defaults based on kind)'),
  lifecycle: z.enum(LIFECYCLES).optional().describe('Note lifecycle: living (mutable), snapshot (immutable), append-only (additive only). Defaults per kind.'),
  tags: z.array(z.string()).optional().describe('Tags for categorization'),
  summary: z.string().describe('One-line present-tense key takeaway'),
  guidance: z.string().describe('Imperative actionable instruction for agents'),
  project: z.string().optional().describe('Project scope — auto-adds project:<name> tag'),
  client: z.string().optional().describe('Client identifier (e.g. claude-code, opencode). Auto-detected from content when omitted.'),
  related: z.array(z.string()).optional().describe('IDs of related notes to link via wikilinks'),
  model: z.string().optional().describe('Your model identifier (e.g. claude-opus-4, gpt-4o). Enables richer responses for capable models.'),
});

server.registerTool(
  'knowledge-store',
  {
    description: 'Store knowledge in the persistent Zettelkasten knowledge base. One concept per note.',
    inputSchema: storeSchema as unknown as AnySchema,
  },
  async (args: z.infer<typeof storeSchema>) => {
    try {
      const result = await handleStore({
        title: args.title,
        content: args.content,
        kind: args.kind as NoteKind,
        status: args.status,
        lifecycle: args.lifecycle,
        tags: args.tags,
        summary: args.summary,
        guidance: args.guidance,
        project: args.project,
        client: args.client,
        related: args.related,
        model: args.model,
      }, await getOrCreateRepo(), getEmbeddingConfig(), config);
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

// ---- knowledge-ingest ----

const ingestSchema = z.object({
  url: z.string().url()
    .refine(u => { try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; } }, { message: 'URL must use http:// or https://' })
    .optional()
    .describe('URL to fetch and extract. Fallback only — the built-in fetcher cannot handle JavaScript-rendered pages, bot protection, or authenticated content. If you have a web tool (Playwright, Exa, web_fetch), fetch with that and pass html instead. When passing html, also pass url for relative link resolution.'),
  html: z.string().optional().describe('Preferred — raw HTML to extract content from. Pass HTML you already fetched via Playwright, Exa, web_fetch, or any browser/web tool for best results.'),
  model: z.string().optional().describe('Your model identifier (e.g. claude-opus-4, gpt-4o). Enables richer responses for capable models.'),
}).refine(d => d.url || d.html, { message: 'At least one of url or html must be provided' });

server.registerTool(
  'knowledge-ingest',
  {
    description: 'Extract article content as clean markdown. Returns title, content, word count, and metadata. PREFER passing html from your own web tools (Playwright, Exa, web_fetch) — the built-in url fetcher is a basic fallback that cannot render JavaScript or bypass bot protection. Use the extracted content to create notes via knowledge-store.',
    inputSchema: ingestSchema as unknown as AnySchema,
  },
  async (args: z.infer<typeof ingestSchema>) => {
    try {
      const result = await handleIngest({
        url: args.url,
        html: args.html,
        model: args.model,
      }, await getOrCreateRepo());
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (error) {
      logToFile('ERROR', 'knowledge-ingest failed', {
        url: args.url,
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
  lifecycle: z.enum(LIFECYCLES).optional().describe('Filter by lifecycle: living, snapshot, append-only'),
  project: z.string().optional().describe('Filter by project tag'),
  client: z.string().optional().describe('Your client name — excludes notes scoped to other clients'),
  tags: z.array(z.string()).optional().describe('Filter by tags (all must match)'),
  limit: z.number().optional().describe('Max results (default 10)'),
  model: z.string().optional().describe('Your model identifier (e.g. claude-opus-4, gpt-4o). Enables richer responses for capable models.'),
});

server.registerTool(
  'knowledge-search',
  {
    description: 'Search the persistent knowledge base using full-text search and semantic similarity. Accepts natural language queries, keywords, or phrases. Returns matching notes with full content.',
    inputSchema: searchSchema as unknown as AnySchema,
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
        lifecycle: args.lifecycle,
        project: args.project,
        client: args.client,
        tags: args.tags,
        limit: args.limit,
        model: args.model,
      }, await getOrCreateRepo(), queryEmbedding, config);
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

// ---- knowledge-overview ----

const overviewSchema = z.object({
  project: z.string().describe('Project name to get overview for'),
  logEntries: z.number().int().min(1).optional().describe('Number of recent log entries to show (default: 10)'),
  model: z.string().optional().describe('Your model identifier (e.g. claude-opus-4, gpt-4o). Enables richer responses for capable models.'),
});

server.registerTool(
  'knowledge-overview',
  {
    description: 'Get a project overview: auto-generated index (catalog of all project notes) and recent operations log. The project entry point for navigation.',
    inputSchema: overviewSchema as unknown as AnySchema,
  },
  async (args: z.infer<typeof overviewSchema>) => {
    try {
      const result = handleOverview({
        project: args.project,
        logEntries: args.logEntries,
        model: args.model,
      }, await getOrCreateRepo(), config);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (error) {
      logToFile('ERROR', 'knowledge-overview failed', {
        error: error instanceof Error ? error.message : String(error),
      }, config);
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// ---- knowledge-open ----

const openSchema = z.object({
  project: z.string().optional().describe('Open focused on a specific project\'s index note'),
});

server.registerTool(
  'knowledge-open',
  {
    description: 'Open the knowledge base vault in Obsidian for visual browsing. Detects Obsidian installation and launches it pointed at the vault.',
    inputSchema: openSchema as unknown as AnySchema,
  },
  async (args: z.infer<typeof openSchema>) => {
    try {
      const result = await handleOpen({
        project: args.project,
      }, config, args.project ? await getOrCreateRepo() : repo ?? undefined);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (error) {
      logToFile('ERROR', 'knowledge-open failed', {
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
  action: z.enum(['stats', 'promote', 'archive', 'delete', 'rebuild', 'format', 'upgrade', 'upgrade-read', 'upgrade-apply', 'review', 'dedupe', 'embed', 'agent-docs', 'scope-audit', 'orphans', 'broken-links', 'migrate-layout', 'upgrade-vault', 'full'])
      .describe('Maintenance action: stats, review (pending notes), dedupe (duplicates), promote, archive, delete, rebuild, format (re-serialize all note files with canonical frontmatter and navigation), upgrade, embed (backfill embeddings), agent-docs (audit/repair managed agent instruction files), scope-audit (detect mis-scoped client tags), orphans (notes with no links), broken-links (wikilinks to non-existent notes), migrate-layout (move flat vault to kind-based directory structure), upgrade-vault (refresh Obsidian scaffold assets), or full (composite: rebuild → migrate-layout → format → dedupe → embed → broken-links → stats, in dependency order).'),
  noteId: z.string().optional().describe('Note ID (required for promote/archive/delete; migration ID for upgrade-read)'),
  filter: z.enum(['fleeting', 'permanent']).optional().describe('Filter for review action: fleeting or permanent notes'),
  days: z.number().optional().describe('Days threshold for review (default: from lifecycle.reviewAfterDays config)'),
  limit: z.number().optional().describe('Max notes to show (default: 3 for review)'),
  telemetry: z.boolean().optional().describe('Include 30-day local-only tool invocation aggregates in stats output'),
  dryRun: z.boolean().optional().describe('Preview changes without applying'),
  model: z.string().optional().describe('Your model identifier (e.g. claude-opus-4, gpt-4o). Enables richer responses for capable models.'),
});

server.registerTool(
  'knowledge-maintain',
  {
    description: 'Maintain the knowledge base: stats, review (pending notes), dedupe (duplicates), promote, archive, delete, rebuild, upgrade, and managed agent docs repair.',
    inputSchema: maintainSchema as unknown as AnySchema,
  },
  async (args: z.infer<typeof maintainSchema>) => {
    try {
      const result = await handleMaintain({
        action: args.action,
        noteId: args.noteId,
        filter: args.filter as 'fleeting' | 'permanent' | undefined,
        days: args.days,
        limit: args.limit,
        telemetry: args.telemetry,
        dryRun: args.dryRun,
        model: args.model,
      }, await getOrCreateRepo(), config, getEmbeddingConfig(), PKG_VERSION);
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

// ---- knowledge-mine ----

const mineSchema = z.object({
  candidates: z.array(z.object({
    title: z.string().describe('Note title — 3-6 word scannable label (max 10 words / 80 chars). Detail belongs in summary.'),
    content: z.string().describe('Note content — the extracted knowledge'),
    kind: z.enum(STORABLE_KINDS).describe('Note kind'),
    summary: z.string().describe('One-line present-tense key takeaway'),
    guidance: z.string().describe('Imperative actionable instruction for agents'),
    tags: z.array(z.string()).optional().describe('Tags for categorization'),
    source: z.string().optional().describe('Provenance — e.g. session ID where this was found'),
  })).describe('Array of candidate notes extracted from session history'),
  project: z.string().optional().describe('Project scope — auto-adds project:<name> tag to all candidates'),
  dry_run: z.boolean().optional().describe('Preview dedup results without storing (default: true)'),
  model: z.string().optional().describe('Your model identifier for richer responses'),
});

server.registerTool(
  'knowledge-mine',
  {
    description: 'Bulk-screen candidate notes for duplicates and optionally store. Accepts candidates extracted by the agent from session history or other sources. Returns each candidate annotated with STORE/SKIP/REVIEW based on similarity to existing KB notes. Default is dry-run (preview only).',
    inputSchema: mineSchema as unknown as AnySchema,
  },
  async (args: z.infer<typeof mineSchema>) => {
    try {
      const result = await handleMine({
        candidates: args.candidates.map(candidate => ({
          title: candidate.title,
          content: candidate.content,
          kind: candidate.kind as NoteKind,
          summary: candidate.summary,
          guidance: candidate.guidance,
          tags: candidate.tags,
          source: candidate.source,
        })),
        project: args.project,
        dry_run: args.dry_run,
        model: args.model,
      }, await getOrCreateRepo(), getEmbeddingConfig(), config);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (error) {
      logToFile('ERROR', 'knowledge-mine failed', {
        error: error instanceof Error ? error.message : String(error),
      }, config);
      return {
        content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

// ---- knowledge-template ----

const templateSchema = z.object({
  kind: z.enum(NOTE_KINDS).describe('Note kind to get the canonical template for'),
  project: z.string().optional().describe('Project name — checks for project-specific template overrides'),
  model: z.string().optional().describe('Your model identifier'),
});

server.registerTool(
  'knowledge-template',
  {
    description: 'Get the canonical note template for a specific kind. Returns skeleton structure with positive and negative examples. Consult before storing structured notes (decision, procedure, domain, reference, observation).',
    inputSchema: templateSchema as unknown as AnySchema,
  },
  async (args: z.infer<typeof templateSchema>) => {
    try {
      const r = args.project ? await getOrCreateRepo() : (repo ?? undefined);
      const result = handleTemplate({
        kind: args.kind,
        project: args.project,
        model: args.model,
      }, r);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (error) {
      logToFile('ERROR', 'knowledge-template failed', {
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
