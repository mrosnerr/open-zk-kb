#!/usr/bin/env bun
// mcp-server.ts - MCP stdio server
// Exposes knowledge-store, knowledge-search, knowledge-get, knowledge-mine, knowledge-maintain as MCP tools.
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
import { TOOL_DEFINITIONS } from './tool-meta.js';
import { toZodSchema } from './tool-schemas.js';
import { getConfig, getEmbeddingsConfig } from './config.js';
import { logToFile } from './logger.js';
import { ensureObsidianScaffold } from './obsidian-scaffold.js';
import { handleStore, handleSearch, handleHealth, handleMaintain, handleIngest, handleContextResult, handleOpen, handleMine, handleTemplate, handleGet } from './tool-handlers.js';
import { reportPreviousSessions } from './analytics.js';
import { generateEmbedding, DEFAULT_EMBEDDING_CONFIG } from './embeddings.js';
import { createGitVersioning } from './git-versioning.js';
import type { GitVersioning } from './git-versioning.js';
import type { EmbeddingConfig } from './embeddings.js';
import type { NoteKind } from './types.js';
import type { NoteRepository as NoteRepositoryType } from './storage/NoteRepository.js';
import { PKG_VERSION } from './version.js';

const { NoteRepository } = await import('./storage/NoteRepository.js');

const config = getConfig();
let repo: NoteRepositoryType | null = null;
let repoInitPromise: Promise<NoteRepositoryType> | null = null;
let gitVersioning: GitVersioning | null = null;

export async function getOrCreateRepo(): Promise<NoteRepositoryType> {
  if (repo) return repo;
  if (repoInitPromise) return repoInitPromise;

  repoInitPromise = (async () => {
    const instance = new NoteRepository(config.vault, { telemetryEnabled: config.telemetry.enabled });
    repo = instance;
    logToFile('INFO', 'MCP server: repository opened', { vault: config.vault }, config);

    if (config.versioning.enabled) {
      const versioning = createGitVersioning(config.vault, config.versioning);
      try {
        await versioning.init();
        gitVersioning = versioning;
      } catch (error) {
        gitVersioning = null;
        logToFile('WARN', 'MCP server: git versioning disabled after init failure', {
          error: error instanceof Error ? error.message : String(error),
          vault: config.vault,
        }, config);
      }
    }

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

export function getEmbeddingConfig(): EmbeddingConfig | null {
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

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'open-zk-kb',
    version: PKG_VERSION,
  });

  const storeTool = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-store')!;
  const storeSchema = toZodSchema(storeTool.params) as z.ZodType<any>;

  server.registerTool(
    'knowledge-store',
    {
      description: storeTool.description,
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
        }, await getOrCreateRepo(), getEmbeddingConfig(), config, gitVersioning);
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

  const ingestTool = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-ingest')!;
  const ingestBaseSchema = toZodSchema(ingestTool.params).extend({
    url: z.string().url()
      .refine(u => { try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; } }, { message: 'URL must use http:// or https://' })
      .optional()
      .describe(ingestTool.params.url.description!),
  });
  const ingestSchema = ingestBaseSchema.refine(d => d.url || d.html, { message: 'At least one of url or html must be provided' }) as z.ZodType<any>;

  server.registerTool(
    'knowledge-ingest',
    {
      description: ingestTool.description,
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

  const searchTool = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-search')!;
  const searchSchema = toZodSchema(searchTool.params) as z.ZodType<any>;

  server.registerTool(
    'knowledge-search',
    {
      description: searchTool.description,
      inputSchema: searchSchema as unknown as AnySchema,
    },
    async (args: z.infer<typeof searchSchema>) => {
      try {
        const embConfig = getEmbeddingConfig();
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

  // ---- knowledge-context ----

  const contextTool = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-context')!;
  const contextSchema = toZodSchema(contextTool.params).extend({
    logEntries: z.number().int().min(1).optional().describe(contextTool.params.logEntries.description!),
  }) as z.ZodType<any>;

  server.registerTool(
    'knowledge-context',
    {
      description: contextTool.description,
      inputSchema: contextSchema as unknown as AnySchema,
    },
    async (args: z.infer<typeof contextSchema>) => {
      try {
        const result = handleContextResult({
          project: args.project,
          logEntries: args.logEntries,
          model: args.model,
          includePreferences: args.includePreferences,
          client: args.client,
        }, await getOrCreateRepo(), config);
        return {
          content: [{ type: 'text' as const, text: result.text }],
          ...(result.preferenceCapsule
            ? { structuredContent: { preferenceCapsule: result.preferenceCapsule } }
            : {}),
        };
      } catch (error) {
        logToFile('ERROR', 'knowledge-context failed', {
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

  const openTool = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-open')!;
  const openSchema = toZodSchema(openTool.params) as z.ZodType<any>;

  server.registerTool(
    'knowledge-open',
    {
      description: openTool.description,
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

  // ---- knowledge-get ----

  const getTool = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-get')!;
  const getSchema = toZodSchema(getTool.params) as z.ZodType<any>;

  server.registerTool(
    'knowledge-get',
    {
      description: getTool.description,
      inputSchema: getSchema as unknown as AnySchema,
    },
    async (args: z.infer<typeof getSchema>) => {
      try {
        const result = handleGet({
          noteId: args.noteId,
          model: args.model,
        }, await getOrCreateRepo());
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (error) {
        logToFile('ERROR', 'knowledge-get failed', {
          error: error instanceof Error ? error.message : String(error),
        }, config);
        return {
          content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // ---- knowledge-health ----

  const healthTool = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-health')!;
  const healthSchema = toZodSchema(healthTool.params) as z.ZodType<any>;

  server.registerTool(
    'knowledge-health',
    {
      description: healthTool.description,
      inputSchema: healthSchema as unknown as AnySchema,
    },
    async (args: z.infer<typeof healthSchema>) => {
      try {
        const result = await handleHealth({
          project: args.project,
          period: args.period,
          telemetry: args.telemetry,
          model: args.model,
        }, await getOrCreateRepo(), config, getEmbeddingConfig(), PKG_VERSION, gitVersioning);
        return { content: [{ type: 'text' as const, text: result }] };
      } catch (error) {
        logToFile('ERROR', 'knowledge-health failed', {
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

  const maintainTool = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-maintain')!;
  const maintainSchema = toZodSchema(maintainTool.params) as z.ZodType<any>;

  server.registerTool(
    'knowledge-maintain',
    {
      description: maintainTool.description,
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
          dryRun: args.dryRun,
          model: args.model,
        }, await getOrCreateRepo(), config, getEmbeddingConfig(), PKG_VERSION, gitVersioning);
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

  const mineTool = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-mine')!;
  const mineSchema = toZodSchema(mineTool.params) as z.ZodType<any>;

  server.registerTool(
    'knowledge-mine',
    {
      description: mineTool.description,
      inputSchema: mineSchema as unknown as AnySchema,
    },
    async (args: z.infer<typeof mineSchema>) => {
      try {
        const result = await handleMine({
          candidates: args.candidates.map((candidate: Record<string, unknown>) => ({
            title: candidate.title as string,
            content: candidate.content as string,
            kind: candidate.kind as NoteKind,
            summary: candidate.summary as string,
            guidance: candidate.guidance as string,
            tags: candidate.tags as string[] | undefined,
            source: candidate.source as string | undefined,
            project: candidate.project as string | undefined,
          })),
          project: args.project,
          dry_run: args.dry_run,
          model: args.model,
        }, await getOrCreateRepo(), getEmbeddingConfig(), config, gitVersioning);
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

  const templateTool = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-template')!;
  const templateSchema = toZodSchema(templateTool.params) as z.ZodType<any>;

  server.registerTool(
    'knowledge-template',
    {
      description: templateTool.description,
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

  return server;
}

// ---- Startup ----

export async function startServer() {
  ensureShutdownHandlers();
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logToFile('INFO', 'MCP server: connected via stdio', {}, config);

  // When the MCP client closes stdin (without SIGINT/SIGTERM),
  // ensure we still record session end so the session is reportable.
  process.stdin.once('end', () => shutdownServer());

  // Fire-and-forget: record this session + report previous sessions.
  // Skip entirely when telemetry is disabled to avoid eagerly creating
  // the vault database before the first real tool call.
  if (config.telemetry.enabled) {
    (async () => {
      try {
        const r = await getOrCreateRepo();
        const clientInfo = server.server.getClientVersion();
        const stats = r.getStats();
        const version = PKG_VERSION;
        r.recordSessionStart(
          clientInfo?.name ?? 'unknown',
          clientInfo?.version ?? null,
          stats.total,
          version,
          config.telemetry.share && !process.env.DO_NOT_TRACK,
        );
        await reportPreviousSessions(r);
      } catch {
        // Silent failure — analytics should never block anything
      }
    })().catch(() => {});
  }

  // Warm up embedding model in background so first search gets semantic results
  const embConfig = getEmbeddingConfig();
  if (embConfig) {
    generateEmbedding('warmup', embConfig).catch(() => {
      // Non-fatal — search falls back to FTS5-only
    });
  }
}


export async function shutdownServer() {
  logToFile('INFO', 'MCP server: shutting down', {}, config);

  // Record session end time locally (no network calls)
  try {
    if (repo) repo.recordSessionEnd();
  } catch {
    // Silent failure — never block shutdown
  }
  if (gitVersioning) {
    try {
      gitVersioning.shutdownSync();
    } catch (error) {
      logToFile('WARN', 'MCP server: failed to flush git versioning', {
        error: error instanceof Error ? error.message : String(error),
      }, config);
    }
  }
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

export function ensureShutdownHandlers() {
  if (shutdownHandlersRegistered) return;
  process.on('SIGINT', shutdownServer);
  process.on('SIGTERM', shutdownServer);
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
