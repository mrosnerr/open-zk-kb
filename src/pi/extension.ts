import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CompatibilityCallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

interface JsonSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

interface PiToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: JsonSchema;
  executionMode?: 'sequential' | 'parallel';
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PiToolResult>;
}

interface PiExtensionApi {
  registerTool(tool: PiToolDefinition): void;
  on(event: 'session_shutdown', handler: () => void | Promise<void>): void;
  on(event: 'before_agent_start', handler: (event: BeforeAgentStartEvent) => BeforeAgentStartResult | Promise<BeforeAgentStartResult>): void;
}

interface BeforeAgentStartEvent {
  systemPrompt: string;
}

interface BeforeAgentStartResult {
  systemPrompt?: string;
}

interface BridgeOptions {
  server: StdioServerParameters;
  clientName: string;
  httpUrl?: string;
}

type ToolName = typeof TOOL_DEFINITIONS[number]['name'];

const STRING_ARRAY_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
};

const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['personalization', 'decision', 'procedure', 'reference', 'resource', 'observation', 'domain'] },
    title: { type: 'string' },
    content: { type: 'string' },
    summary: { type: 'string' },
    guidance: { type: 'string' },
    project: { type: 'string' },
    tags: STRING_ARRAY_SCHEMA,
    source: { type: 'string' },
  },
  required: ['kind', 'title', 'content', 'summary', 'guidance'],
  additionalProperties: false,
};

const TOOL_DEFINITIONS = [
  {
    name: 'knowledge-store',
    label: 'Store Knowledge',
    description: 'Store or update a concise persistent knowledge note for future agent sessions.',
    promptSnippet: 'Store or update durable cross-session memory in open-zk-kb.',
    parameters: objectSchema({
      kind: enumSchema(['personalization', 'decision', 'procedure', 'reference', 'resource', 'observation', 'domain']),
      title: { type: 'string' },
      content: { type: 'string' },
      summary: { type: 'string' },
      guidance: { type: 'string' },
      project: { type: 'string' },
      tags: STRING_ARRAY_SCHEMA,
      lifecycle: enumSchema(['living', 'snapshot', 'append-only']),
      client: { type: 'string' },
      status: enumSchema(['fleeting', 'permanent', 'archived']),
      related: STRING_ARRAY_SCHEMA,
      model: { type: 'string' },
    }, ['kind', 'title', 'content', 'summary', 'guidance']),
  },
  {
    name: 'knowledge-ingest',
    label: 'Ingest Knowledge Source',
    description: 'Extract article-style content from a URL or supplied HTML for storage in open-zk-kb.',
    promptSnippet: 'Extract URL or HTML content before storing useful resources in open-zk-kb.',
    parameters: objectSchema({
      url: { type: 'string' },
      html: { type: 'string' },
      model: { type: 'string' },
    }),
  },
  {
    name: 'knowledge-search',
    label: 'Search Knowledge',
    description: 'Search persistent cross-session memory with full-text and semantic retrieval.',
    promptSnippet: 'Search open-zk-kb for relevant prior context and guidance.',
    parameters: objectSchema({
      query: { type: 'string' },
      client: { type: 'string' },
      project: { type: 'string' },
      kind: enumSchema(['personalization', 'decision', 'procedure', 'reference', 'resource', 'observation', 'domain', 'index', 'log']),
      tags: STRING_ARRAY_SCHEMA,
      limit: { type: 'number' },
      status: enumSchema(['fleeting', 'permanent', 'archived']),
      lifecycle: enumSchema(['living', 'snapshot', 'append-only']),
      model: { type: 'string' },
    }, ['query']),
  },
  {
    name: 'knowledge-overview',
    label: 'Knowledge Overview',
    description: 'Get a project knowledge overview: generated index and recent log entries.',
    promptSnippet: 'Load an open-zk-kb project overview at the start of project work.',
    parameters: objectSchema({
      project: { type: 'string' },
      logEntries: { type: 'number' },
      model: { type: 'string' },
    }, ['project']),
  },
  {
    name: 'knowledge-open',
    label: 'Open in Obsidian',
    description: 'Open the knowledge base vault in Obsidian for visual browsing. Detects Obsidian installation and launches it pointed at the vault.',
    promptSnippet: 'Open open-zk-kb notes for human review when requested.',
    parameters: objectSchema({
      project: { type: 'string' },
    }),
  },
  {
    name: 'knowledge-maintain',
    label: 'Maintain Knowledge',
    description: 'Run knowledge base maintenance actions: stats, promote, archive, delete, rebuild, format, upgrade, upgrade-read, upgrade-apply, review, dedupe, embed, agent-docs, scope-audit, orphans, broken-links, migrate-layout, upgrade-vault, full.',
    promptSnippet: 'Inspect or maintain open-zk-kb health and lifecycle state.',
    parameters: objectSchema({
      action: enumSchema(['stats', 'promote', 'archive', 'delete', 'rebuild', 'format', 'upgrade', 'upgrade-read', 'upgrade-apply', 'review', 'dedupe', 'embed', 'agent-docs', 'scope-audit', 'orphans', 'broken-links', 'migrate-layout', 'upgrade-vault', 'full']),
      noteId: { type: 'string' },
      limit: { type: 'number' },
      dryRun: { type: 'boolean' },
      filter: enumSchema(['fleeting', 'permanent']),
      days: { type: 'number' },
      telemetry: { type: 'boolean' },
      model: { type: 'string' },
    }, ['action']),
  },
  {
    name: 'knowledge-mine',
    label: 'Mine Knowledge',
    description: 'Bulk-screen candidate memories from prior sessions for deduplication before storage.',
    promptSnippet: 'Mine previous sessions for candidate open-zk-kb notes.',
    parameters: objectSchema({
      candidates: {
        type: 'array',
        items: CANDIDATE_SCHEMA,
      },
      dry_run: { type: 'boolean' },
      project: { type: 'string' },
      model: { type: 'string' },
    }, ['candidates']),
  },
  {
    name: 'knowledge-get',
    label: 'Get Knowledge Note',
    description: 'Retrieve a single note by its exact ID. Faster and more precise than knowledge-search. Use when you already know the note ID (e.g. from injected context hints).',
    promptSnippet: 'Fetch a specific open-zk-kb note by id for fast retrieval.',
    parameters: objectSchema({
      noteId: { type: 'string' },
      model: { type: 'string' },
    }, ['noteId']),
  },
  {
    name: 'knowledge-template',
    label: 'Knowledge Template',
    description: 'Get the canonical note template for a knowledge kind before storing structured memory.',
    promptSnippet: 'Load an open-zk-kb note template before storing structured knowledge.',
    parameters: objectSchema({
      kind: enumSchema(['personalization', 'decision', 'procedure', 'reference', 'resource', 'observation', 'domain', 'index', 'log']),
      project: { type: 'string' },
      model: { type: 'string' },
    }, ['kind']),
  },
] as const;

const PROMPT_GUIDELINES = [
  'Use knowledge-search before work that may benefit from prior cross-session memory; pass client: "pi" for Pi-specific context.',
  'Use knowledge-store immediately when the user asks you to remember a preference, decision, procedure, observation, reference, or useful resource.',
  'Use knowledge-template before knowledge-store when creating a structured note kind for the first time in a session.',
];

function objectSchema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function enumSchema(values: string[]): Record<string, unknown> {
  return { type: 'string', enum: values };
}

function defaultServerParameters(): StdioServerParameters {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const cliPath = path.resolve(extensionDir, '..', 'cli.js');
  return {
    command: 'bun',
    args: [cliPath, 'server'],
    cwd: process.cwd(),
    stderr: 'pipe',
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function hasContent(result: unknown): result is { content: Array<unknown>; isError?: boolean; structuredContent?: Record<string, unknown> } {
  return Boolean(result && typeof result === 'object' && 'content' in result && Array.isArray((result as { content?: unknown }).content));
}

function textFromMcpContent(content: unknown[]): string {
  const parts = content.map((item) => {
    if (!item || typeof item !== 'object') {
      return String(item);
    }
    const record = item as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      return record.text;
    }
    if (record.type === 'resource' && record.resource && typeof record.resource === 'object') {
      const resource = record.resource as Record<string, unknown>;
      if (typeof resource.text === 'string') {
        return resource.text;
      }
    }
    return JSON.stringify(record);
  });
  return parts.join('\n');
}

class OpenZkKbMcpBridge {
  private client: Client | undefined;
  private transport: (StdioClientTransport | StreamableHTTPClientTransport) | undefined;
  private connecting: Promise<Client> | undefined;
  private stderrTail = '';
  private httpDisabled = false;

  constructor(private readonly options: BridgeOptions) {}

  async callTool(name: ToolName, args: Record<string, unknown>, signal?: AbortSignal): Promise<PiToolResult> {
    if (signal?.aborted) {
      return { content: [{ type: 'text', text: 'Cancelled' }], isError: true };
    }

    try {
      const client = await this.getClient();
      const result = await client.callTool(
        { name, arguments: args },
        CompatibilityCallToolResultSchema,
        signal ? { signal } : undefined,
      );

      if (hasContent(result)) {
        return {
          content: [{ type: 'text', text: textFromMcpContent(result.content) }],
          details: result.structuredContent ? { structuredContent: result.structuredContent } : undefined,
          isError: result.isError,
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (error) {
      await this.reset();
      const stderr = this.stderrTail.trim();
      const suffix = stderr ? `\n\nServer stderr:\n${stderr}` : '';
      return {
        content: [{ type: 'text', text: `open-zk-kb Pi bridge failed: ${formatError(error)}${suffix}` }],
        isError: true,
      };
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }

  private async getClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    if (!this.connecting) {
      this.connecting = this.connect();
    }

    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const client = new Client({ name: this.options.clientName, version: '1.0.0' });

    if (this.options.httpUrl && !this.httpDisabled) {
      try {
        const transport = new StreamableHTTPClientTransport(
          new URL(this.options.httpUrl),
        );
        this.transport = transport;
        await client.connect(transport);
        this.client = client;
        this.connecting = undefined;
        return client;
      } catch {
        // HTTP connection failed — fall back to stdio for this and future calls
        this.httpDisabled = true;
        this.transport = undefined;
      }
    }

    const transport = new StdioClientTransport(this.options.server);
    this.transport = transport;
    this.captureStderr(transport);
    await client.connect(transport);
    this.client = client;
    this.connecting = undefined;
    return client;
  }

  private captureStderr(transport: StdioClientTransport): void {
    const stderr = transport.stderr;
    if (!stderr) {
      return;
    }
    stderr.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4000);
    });
  }

  private async reset(): Promise<void> {
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
    if (transport) {
      await transport.close().catch(() => undefined);
    }
  }
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isLocalHost(host: string): boolean {
  return isLoopbackHost(host) || host === '0.0.0.0' || host === '::';
}

function detectHttpServer(): string | undefined {
  try {
    // Prefer XDG_RUNTIME_DIR (per-user, secure permissions on Linux).
    // Fall back to TMPDIR (macOS sets this to a per-user private temp dir).
    // Never fall back to /tmp — it's world-writable and allows state-file injection.
    const runtimeDir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR;
    if (!runtimeDir) return undefined;

    const stateFile = path.join(runtimeDir, 'open-zk-kb', 'server.json');
    const content = fs.readFileSync(stateFile, 'utf-8');
    const state = JSON.parse(content) as { pid: number; host: string; port: number };

    // Validate shape
    if (typeof state.pid !== 'number' || typeof state.host !== 'string' || typeof state.port !== 'number') {
      return undefined;
    }

    // Only trust loopback and wildcard bind addresses for auto-discovery
    if (!isLocalHost(state.host)) return undefined;

    // Normalize wildcard bind addresses to loopback for probing
    const probeHost = (state.host === '0.0.0.0' || state.host === '::')
      ? '127.0.0.1'
      : state.host;

    // Verify process is alive
    process.kill(state.pid, 0);

    // Bracket IPv6 hosts per RFC 3986
    const hostForUrl = probeHost.includes(':') ? `[${probeHost}]` : probeHost;
    return `http://${hostForUrl}:${state.port}/mcp`;
  } catch {
    return undefined;
  }
}

export function createOpenZkKbPiExtension(options?: Partial<BridgeOptions>) {
  return (pi: PiExtensionApi): void => {
    const bridge = new OpenZkKbMcpBridge({
      server: options?.server ?? defaultServerParameters(),
      clientName: options?.clientName ?? 'open-zk-kb-pi',
      httpUrl: options?.httpUrl ?? detectHttpServer(),
    });

    for (const definition of TOOL_DEFINITIONS) {
      pi.registerTool({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        promptSnippet: definition.promptSnippet,
        promptGuidelines: PROMPT_GUIDELINES,
        parameters: definition.parameters,
        executionMode: 'sequential',
        execute: (_toolCallId, params, signal) => bridge.callTool(definition.name, params, signal),
      });
    }

    pi.on('before_agent_start', (event) => {
      if (event.systemPrompt.includes('OPEN-ZK-KB:START') || event.systemPrompt.includes('knowledge-search')) {
        return {};
      }
      return {
        systemPrompt: `${event.systemPrompt}\n\nOpen-zk-kb persistent memory is available through the knowledge-* tools. Search first with knowledge-search when prior context may matter, pass client: "pi", and store durable user preferences, decisions, procedures, observations, references, and resources with knowledge-store.`,
      };
    });

    pi.on('session_shutdown', () => bridge.close());
  };
}

export default createOpenZkKbPiExtension();
