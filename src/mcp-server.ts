#!/usr/bin/env bun
// mcp-server.ts - MCP stdio server
// Exposes knowledge-store, knowledge-search, knowledge-maintain as MCP tools.
// Stdout is the MCP transport — use logToFile() for all logging.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { NoteRepository } from './storage/NoteRepository.js';
import { getConfig, getOpenCodeConfig } from './config.js';
import { logToFile } from './logger.js';
import { handleStore, handleSearch, handleMaintain } from './tool-handlers.js';
import { generateEmbedding } from './embeddings.js';
import type { EmbeddingConfig } from './embeddings.js';
import type { NoteKind } from './types.js';

const config = getConfig();
let repo: NoteRepository | null = null;

function getOrCreateRepo(): NoteRepository {
  if (!repo) {
    repo = new NoteRepository(config.vault);
    logToFile('INFO', 'MCP server: repository opened', { vault: config.vault }, config);
  }
  return repo;
}

let cachedEmbeddingConfig: EmbeddingConfig | null | undefined;

function getEmbeddingConfig(): EmbeddingConfig | null {
  if (cachedEmbeddingConfig !== undefined) return cachedEmbeddingConfig;

  const oc = getOpenCodeConfig();
  if (!oc?.embeddings?.enabled || !oc?.embeddings?.model) {
    cachedEmbeddingConfig = null;
    return null;
  }

  const baseUrl = oc.embeddings.base_url || oc.provider?.base_url;
  const apiKey = oc.embeddings.api_key || oc.provider?.api_key;
  if (!baseUrl || !apiKey) {
    cachedEmbeddingConfig = null;
    return null;
  }

  cachedEmbeddingConfig = {
    baseUrl,
    apiKey,
    model: oc.embeddings.model,
    dimensions: oc.embeddings.dimensions || 1536,
  };
  return cachedEmbeddingConfig;
}


const server = new McpServer({
  name: 'open-zk-kb',
  version: '0.1.0',
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

const searchSchema = z.object({
  query: z.string().describe('Search query — keywords or phrases'),
  kind: z.enum(NOTE_KINDS).optional().describe('Filter by note kind'),
  status: z.enum(['fleeting', 'permanent', 'archived']).optional().describe('Filter by status'),
  project: z.string().optional().describe('Filter by project tag'),
  limit: z.number().optional().describe('Max results (default 10)'),
});

server.registerTool(
  'knowledge-search',
  {
    description: 'Search the persistent knowledge base using full-text search.',
    inputSchema: searchSchema as any,
  },
  async (args: z.infer<typeof searchSchema>) => {
    try {
      const embConfig = getEmbeddingConfig();
      let queryEmbedding: number[] | null = null;
      if (embConfig) {
        const embResult = await generateEmbedding(args.query, embConfig);
        queryEmbedding = embResult?.embedding || null;
      }

      const result = handleSearch({
        query: args.query,
        kind: args.kind as NoteKind | undefined,
        status: args.status,
        project: args.project,
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
  action: z.enum(['stats', 'promote', 'archive', 'delete', 'rebuild', 'upgrade', 'upgrade-read', 'upgrade-apply', 'review', 'dedupe', 'embed'])
    .describe('Maintenance action: stats, review (pending notes), dedupe (duplicates), promote, archive, delete, rebuild, upgrade, embed (backfill embeddings)'),
  noteId: z.string().optional().describe('Note ID (required for promote/archive/delete; migration ID for upgrade-read)'),
  filter: z.enum(['fleeting', 'permanent']).optional().describe('Filter for review action: fleeting or permanent notes'),
  days: z.number().optional().describe('Days threshold for review (default: 14)'),
  limit: z.number().optional().describe('Max notes to show (default: 3 for review)'),
  dryRun: z.boolean().optional().describe('Preview changes without applying'),
});

server.registerTool(
  'knowledge-maintain',
  {
    description: 'Maintain the knowledge base: stats, review (pending notes), dedupe (duplicates), promote, archive, delete, rebuild, upgrade.',
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
      }, getOrCreateRepo(), config, getEmbeddingConfig());
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logToFile('INFO', 'MCP server: connected via stdio', {}, config);
}

// Graceful shutdown
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

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((error) => {
  logToFile('ERROR', 'MCP server: startup failed', {
    error: error instanceof Error ? error.message : String(error),
  }, config);
  process.exit(1);
});
