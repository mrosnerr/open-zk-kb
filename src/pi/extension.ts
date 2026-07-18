import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CompatibilityCallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ExtensionAPI, ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent';
import { TOOL_DEFINITIONS } from '../tool-meta.js';
import { toTypeBoxSchema } from './tool-schemas.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface BridgeOptions {
  server: StdioServerParameters;
  clientName: string;
  httpUrl?: string;
}

type ToolName = typeof TOOL_DEFINITIONS[number]['name'];

// ─── MCP Bridge ──────────────────────────────────────────────────────────────

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

  async callTool(name: ToolName, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown> | undefined>> {
    if (signal?.aborted) {
      throw new Error('Cancelled');
    }

    let toolErrorText: string | undefined;
    try {
      const client = await this.getClient();
      const result = await client.callTool(
        { name, arguments: args },
        CompatibilityCallToolResultSchema,
        signal ? { signal } : undefined,
      );

      if (hasContent(result)) {
        const text = textFromMcpContent(result.content);
        if (result.isError) {
          // Tool-level error — defer throw until after try/catch to avoid resetting the bridge
          toolErrorText = text;
        } else {
          return {
            content: [{ type: 'text', text }],
            details: result.structuredContent ? { structuredContent: result.structuredContent } : undefined,
          };
        }
      }

      if (!toolErrorText) {
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: undefined,
        };
      }
    } catch (error) {
      // Transport/protocol failure — reset the bridge for reconnection
      await this.reset();
      const stderr = this.stderrTail.trim();
      const suffix = stderr ? `\n\nServer stderr:\n${stderr}` : '';
      throw new Error(`open-zk-kb: ${formatError(error)}${suffix}`, { cause: error });
    }

    // Tool-level error — throw outside try/catch so the bridge is NOT reset
    throw new Error(toolErrorText);
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
    if (this.options.httpUrl && !this.httpDisabled) {
      const client = new Client({ name: this.options.clientName, version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(
        new URL(this.options.httpUrl),
      );
      this.transport = transport;
      try {
        await client.connect(transport);
        this.client = client;
        this.connecting = undefined;
        return client;
      } catch {
        // HTTP connection failed — fall back to stdio for this and future calls.
        this.httpDisabled = true;
        this.transport = undefined;
        await transport.close().catch(() => undefined);
      }
    }

    const client = new Client({ name: this.options.clientName, version: '1.0.0' });
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

// ─── HTTP Server Detection ───────────────────────────────────────────���───────

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
    if (process.platform !== 'win32') {
      const processUid = process.getuid?.();
      if (processUid === undefined) return undefined;
      const stat = fs.statSync(stateFile);
      if (stat.uid !== processUid) return undefined;
    }

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

// ─── Extension Entry Point ───────────────────────────────────────────────────

export function createOpenZkKbPiExtension(options?: Partial<BridgeOptions>) {
  return (pi: ExtensionAPI): void => {
    const bridge = new OpenZkKbMcpBridge({
      server: options?.server ?? defaultServerParameters(),
      clientName: options?.clientName ?? 'open-zk-kb-pi',
      httpUrl: 'httpUrl' in (options ?? {}) ? options!.httpUrl : detectHttpServer(),
    });

    for (const definition of TOOL_DEFINITIONS) {
      const parameters = toTypeBoxSchema(definition.params);
      pi.registerTool({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        promptSnippet: definition.promptSnippet,
        promptGuidelines: 'promptGuidelines' in definition ? definition.promptGuidelines : undefined,
        parameters,
        executionMode: definition.executionMode,
        execute: (_toolCallId, params, signal) => bridge.callTool(definition.name, params as Record<string, unknown>, signal),
      } as ToolDefinition);
    }

    pi.on('before_agent_start', (event) => {
      // Skip injection if the skill or agent docs already provide KB instructions
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
