import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Box, Text } from '@earendil-works/pi-tui';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CompatibilityCallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS } from '../tool-meta.js';
import { RENDER_RESULTS } from './renderers.js';
import { toTypeBoxSchema } from './tool-schemas.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface BridgeOptions {
  server: StdioServerParameters;
  clientName: string;
  httpUrl?: string;
}

type ToolName = (typeof TOOL_DEFINITIONS)[number]['name'];

const MUTATING_TOOLS = new Set<ToolName>(['knowledge-store', 'knowledge-ingest', 'knowledge-maintain', 'knowledge-mine']);
const ROUTINE_STORED_KNOWLEDGE_TOOLS = new Set<ToolName>([
  'knowledge-store',
  'knowledge-search',
  'knowledge-get',
  'knowledge-context',
  'knowledge-health',
  'knowledge-mine',
]);

function preferenceText(result: AgentToolResult<Record<string, unknown> | undefined>): string | undefined {
  const structured = result.details?.structuredContent;
  if (!structured || typeof structured !== 'object') return undefined;
  const capsule = (structured as Record<string, unknown>).preferenceCapsule;
  if (!capsule || typeof capsule !== 'object') return undefined;
  const text = (capsule as Record<string, unknown>).text;
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

const PREFERENCE_ENTRY_TYPE = 'open-zk-kb-preferences';

interface PreferenceEntryData {
  fingerprint: string;
  preferences: Array<{ scope: string; guidance: string }>;
}

function preferenceEntryData(capsule: string): PreferenceEntryData {
  const oscPattern = new RegExp(String.raw`\x1b\][^\x07]*(?:\x07|$)`, 'g');
  const csiPattern = new RegExp(String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|[()][0-2A-Za-z])`, 'g');
  const withoutAnsi = capsule.replace(oscPattern, '').replace(csiPattern, '');
  const clean = [...withoutAnsi]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 10 || code === 13 || code === 9 || (code >= 32 && code !== 127);
    })
    .join('');
  const preferences = clean
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^-?\s*\[([^\]]+)]\s*(.*)$/);
      if (!match) return undefined;
      const [, scope, rawGuidance] = match;
      if (!scope || !rawGuidance) return undefined;
      return {
        scope,
        guidance: rawGuidance
          .replace(/\s*\(id:\s*[^)]+\)\s*$/, '')
          .replace(/\s*\[\d{12,16}]\s*$/, '')
          .trim(),
      };
    })
    .filter((item): item is { scope: string; guidance: string } => Boolean(item?.guidance));
  return { fingerprint: clean, preferences };
}

// ─── MCP Bridge ──────────────────────────────────────────────────────────────

const DEMO_ISOLATION_ENV = ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME'] as const;

function serverEnvironment(): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const name of DEMO_ISOLATION_ENV) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

function defaultServerParameters(): StdioServerParameters {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const cliPath = path.resolve(extensionDir, '..', 'cli.js');
  return {
    command: 'bun',
    args: [cliPath, 'server'],
    cwd: process.cwd(),
    env: serverEnvironment(),
    stderr: 'pipe',
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function hasContent(result: unknown): result is {
  content: Array<unknown>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
} {
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
      const result = await client.callTool({ name, arguments: args }, CompatibilityCallToolResultSchema, signal ? { signal } : undefined);

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
      // Abort/cancel — re-throw without resetting the shared bridge
      if (error instanceof Error && (error.name === 'AbortError' || signal?.aborted)) {
        throw error;
      }
      // Transport/protocol failure — reset the bridge for reconnection
      await this.reset();
      const stderr = this.stderrTail.trim();
      const suffix = stderr ? `\n\nServer stderr:\n${stderr}` : '';
      throw new Error(`open-zk-kb: ${formatError(error)}${suffix}`, {
        cause: error,
      });
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
      const client = new Client({
        name: this.options.clientName,
        version: '1.0.0',
      });
      const transport = new StreamableHTTPClientTransport(new URL(this.options.httpUrl));
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

    const client = new Client({
      name: this.options.clientName,
      version: '1.0.0',
    });
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
    const state = JSON.parse(content) as {
      pid: number;
      host: string;
      port: number;
    };

    // Validate shape
    if (typeof state.pid !== 'number' || typeof state.host !== 'string' || typeof state.port !== 'number') {
      return undefined;
    }

    // Only trust loopback and wildcard bind addresses for auto-discovery
    if (!isLocalHost(state.host)) return undefined;

    // Normalize wildcard bind addresses to loopback for probing
    const probeHost = state.host === '0.0.0.0' || state.host === '::' ? '127.0.0.1' : state.host;

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
      httpUrl: options && 'httpUrl' in options ? options.httpUrl : detectHttpServer(),
    });

    let project: string | undefined;
    let capsuleRequest: Promise<string | undefined> | undefined;
    let sessionGeneration = 0;

    pi.registerEntryRenderer<PreferenceEntryData>(PREFERENCE_ENTRY_TYPE, (entry, { expanded }, theme) => {
      const preferences = entry.data?.preferences ?? [];
      const box = new Box(1, 0, (text) => theme.bg('customMessageBg', text));
      const count = `${preferences.length} session preference${preferences.length === 1 ? '' : 's'} loaded automatically`;
      box.addChild(new Text(theme.bold('knowledge-context'), 0, 0));
      box.addChild(new Text(theme.fg('success', `✓ ${count}`), 0, 0));
      if (expanded) {
        box.addChild(new Text('', 0, 0));
        for (const preference of preferences) {
          box.addChild(new Text(`${theme.fg('muted', `[${preference.scope}]`)} ${theme.fg('text', preference.guidance)}`, 0, 0));
        }
      }
      return box;
    });

    const loadCapsule = (): Promise<string | undefined> => {
      if (!project) return Promise.resolve(undefined);
      if (!capsuleRequest) {
        const request = bridge
          .callTool('knowledge-context', {
            project,
            client: 'pi',
            includePreferences: true,
          })
          .then(preferenceText)
          .catch(() => {
            // Do not permanently disable personalization after a transient failure.
            if (capsuleRequest === request) capsuleRequest = undefined;
            return undefined;
          });
        capsuleRequest = request;
      }
      return capsuleRequest;
    };

    for (const definition of TOOL_DEFINITIONS) {
      const parameters = toTypeBoxSchema(definition.params);
      const renderResult = RENDER_RESULTS[definition.name];
      pi.registerTool({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        promptSnippet: definition.promptSnippet,
        promptGuidelines: 'promptGuidelines' in definition ? [...definition.promptGuidelines] : undefined,
        parameters,
        executionMode: definition.executionMode,
        execute: async (_toolCallId, params, signal) => {
          const args = params as Record<string, unknown>;
          let routineArgs = args;
          if (ROUTINE_STORED_KNOWLEDGE_TOOLS.has(definition.name)) {
            const boundedArgs = { ...args };
            delete boundedArgs.project;
            delete boundedArgs.client;
            routineArgs = { ...boundedArgs, ...(project ? { project } : {}), client: 'pi' };
          }
          const result = await bridge.callTool(definition.name, routineArgs, signal);
          if (MUTATING_TOOLS.has(definition.name)) capsuleRequest = undefined;
          return result;
        },
        renderResult: renderResult ?? undefined,
      });
    }

    pi.on('session_start', async (_event, ctx) => {
      const generation = ++sessionGeneration;
      project = path.basename(ctx.cwd);
      capsuleRequest = undefined;
      const capsulePromise = loadCapsule();
      if (ctx.mode !== 'tui') return;
      const capsule = await capsulePromise;
      if (!capsule || generation !== sessionGeneration) return;

      const data = preferenceEntryData(capsule);
      if (data.preferences.length === 0) return;
      const alreadyPresent = ctx.sessionManager
        .getEntries()
        .some((entry) => entry.type === 'custom' && entry.customType === PREFERENCE_ENTRY_TYPE && (entry.data as Partial<PreferenceEntryData> | undefined)?.fingerprint === data.fingerprint);
      if (!alreadyPresent) pi.appendEntry(PREFERENCE_ENTRY_TYPE, data);
    });

    pi.on('before_agent_start', async (event) => {
      const capsule = await loadCapsule();
      const hasGuidance = event.systemPrompt.includes('OPEN-ZK-KB:START') || event.systemPrompt.includes('knowledge-search');
      const additions: string[] = [];
      if (!hasGuidance) {
        additions.push(
          'Open-zk-kb persistent memory is available through the knowledge-* tools. Search first with knowledge-search when prior context may matter, pass client: "pi", and store durable user preferences, decisions, procedures, observations, references, and resources with knowledge-store.',
        );
      }
      if (capsule) additions.push(`Personalization preferences:\n${capsule}`);
      return additions.length ? { systemPrompt: `${event.systemPrompt}\n\n${additions.join('\n\n')}` } : {};
    });

    pi.on('session_shutdown', () => bridge.close());
  };
}

export default createOpenZkKbPiExtension();
