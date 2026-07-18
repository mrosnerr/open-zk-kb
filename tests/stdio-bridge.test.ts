import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Server } from 'bun';
import {
  READ_ONLY_TOOLS,
  buildMcpRequestHeaders,
  isRetriableSingleRequest,
  isRetriableRequest,
  isJsonRpcNotification,
  isNotificationOnlyMessage,
} from '../src/mcp-stdio-proxy.js';

const CLI_PATH = path.resolve('dist/cli.js');
if (!fs.existsSync(CLI_PATH)) {
  throw new Error('dist/cli.js not found — run `bun run build` before `bun test`');
}

const INTEGRATION = process.env.INTEGRATION_TESTS === '1';

// ---- Unit: retry classifier ----

describe('READ_ONLY_TOOLS', () => {
  it('includes only side-effect-free tools', () => {
    expect(READ_ONLY_TOOLS['knowledge-search']).toBe(true);
    expect(READ_ONLY_TOOLS['knowledge-get']).toBe(true);
    expect(READ_ONLY_TOOLS['knowledge-health']).toBe(true);
    expect(READ_ONLY_TOOLS['knowledge-context']).toBe(true);
    expect(READ_ONLY_TOOLS['knowledge-template']).toBe(true);
  });

  it('does not include mutating tools', () => {
    expect(READ_ONLY_TOOLS['knowledge-store']).toBeUndefined();
    expect(READ_ONLY_TOOLS['knowledge-maintain']).toBeUndefined();
    expect(READ_ONLY_TOOLS['knowledge-ingest']).toBeUndefined();
    expect(READ_ONLY_TOOLS['knowledge-mine']).toBeUndefined();
    expect(READ_ONLY_TOOLS['knowledge-open']).toBeUndefined();
  });
});

describe('buildMcpRequestHeaders', () => {
  it('adds the configured bearer token', () => {
    expect(buildMcpRequestHeaders('test-token')).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer test-token',
    });
  });

  it('preserves unauthenticated request headers when no token is configured', () => {
    expect(buildMcpRequestHeaders()).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    });
  });
});

describe('isRetriableSingleRequest', () => {
  const call = (name: string) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: {} },
  });

  it('treats non-object requests as retriable (falls through)', () => {
    expect(isRetriableSingleRequest(null)).toBe(true);
    expect(isRetriableSingleRequest(undefined)).toBe(true);
    expect(isRetriableSingleRequest('not-json')).toBe(true);
    expect(isRetriableSingleRequest(42)).toBe(true);
  });

  it('treats requests without a string method as retriable', () => {
    expect(isRetriableSingleRequest({ id: 1 })).toBe(true);
    expect(isRetriableSingleRequest({ id: 1, method: null })).toBe(true);
    expect(isRetriableSingleRequest({ id: 1, method: 42 })).toBe(true);
  });

  it('treats non-tools/call methods as retriable', () => {
    expect(isRetriableSingleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe(true);
    expect(isRetriableSingleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' })).toBe(true);
    expect(isRetriableSingleRequest({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(true);
    expect(isRetriableSingleRequest({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).toBe(true);
  });

  it('treats read-only tools/call as retriable', () => {
    expect(isRetriableSingleRequest(call('knowledge-search'))).toBe(true);
    expect(isRetriableSingleRequest(call('knowledge-get'))).toBe(true);
    expect(isRetriableSingleRequest(call('knowledge-health'))).toBe(true);
    expect(isRetriableSingleRequest(call('knowledge-context'))).toBe(true);
    expect(isRetriableSingleRequest(call('knowledge-template'))).toBe(true);
  });

  it('treats write tools/call as NOT retriable', () => {
    expect(isRetriableSingleRequest(call('knowledge-store'))).toBe(false);
    expect(isRetriableSingleRequest(call('knowledge-maintain'))).toBe(false);
    expect(isRetriableSingleRequest(call('knowledge-ingest'))).toBe(false);
    expect(isRetriableSingleRequest(call('knowledge-mine'))).toBe(false);
    expect(isRetriableSingleRequest(call('knowledge-open'))).toBe(false);
  });

  it('treats unknown tools/call as NOT retriable (safe default)', () => {
    expect(isRetriableSingleRequest(call('unknown-future-tool'))).toBe(false);
    expect(isRetriableSingleRequest(call(''))).toBe(false);
  });

  it('treats tools/call with missing params as NOT retriable', () => {
    expect(isRetriableSingleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
    })).toBe(false);
    expect(isRetriableSingleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: null,
    })).toBe(false);
    expect(isRetriableSingleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: 'string-not-object',
    })).toBe(false);
  });

  it('treats tools/call with non-string tool name as NOT retriable', () => {
    expect(isRetriableSingleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 42 },
    })).toBe(false);
    expect(isRetriableSingleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: {},
    })).toBe(false);
  });
});

describe('isRetriableRequest', () => {
  const readCall = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knowledge-search' } };
  const writeCall = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'knowledge-store' } };
  const list = { jsonrpc: '2.0', id: 3, method: 'tools/list' };

  it('delegates single requests to isRetriableSingleRequest', () => {
    expect(isRetriableRequest(readCall)).toBe(true);
    expect(isRetriableRequest(writeCall)).toBe(false);
  });

  it('returns true for a batch where every item is retriable', () => {
    expect(isRetriableRequest([readCall, list])).toBe(true);
    expect(isRetriableRequest([readCall, readCall, list])).toBe(true);
  });

  it('returns false if any batch item is not retriable', () => {
    expect(isRetriableRequest([readCall, writeCall])).toBe(false);
    expect(isRetriableRequest([writeCall, list])).toBe(false);
  });

  it('returns true for empty batch (vacuously retriable)', () => {
    expect(isRetriableRequest([])).toBe(true);
  });
});

describe('isJsonRpcNotification', () => {
  it('treats messages without id as notifications', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'ping' })).toBe(true);
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(true);
  });

  it('treats messages with id as NOT notifications', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(false);
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: null, method: 'ping' })).toBe(false);
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 'abc', method: 'ping' })).toBe(false);
  });

  it('treats non-objects as NOT notifications', () => {
    expect(isJsonRpcNotification(null)).toBe(false);
    expect(isJsonRpcNotification(undefined)).toBe(false);
    expect(isJsonRpcNotification('string')).toBe(false);
    expect(isJsonRpcNotification(42)).toBe(false);
  });
});

describe('isNotificationOnlyMessage', () => {
  const notif = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const req = { jsonrpc: '2.0', id: 1, method: 'ping' };

  it('returns true for a single notification', () => {
    expect(isNotificationOnlyMessage(notif)).toBe(true);
  });

  it('returns false for a single request', () => {
    expect(isNotificationOnlyMessage(req)).toBe(false);
  });

  it('returns true for a batch of only notifications', () => {
    expect(isNotificationOnlyMessage([notif, notif])).toBe(true);
  });

  it('returns false for a batch mixing notifications and requests', () => {
    expect(isNotificationOnlyMessage([notif, req])).toBe(false);
    expect(isNotificationOnlyMessage([req, notif])).toBe(false);
  });

  it('returns false for a batch of only requests', () => {
    expect(isNotificationOnlyMessage([req, req])).toBe(false);
  });

  it('returns false for an empty batch (no notifications to fire-and-forget)', () => {
    expect(isNotificationOnlyMessage([])).toBe(false);
  });
});

/**
 * Integration tests for the stdio→HTTP bridge self-healing behavior.
 *
 * These tests verify that when the HTTP server goes down and restarts,
 * the bridge proxy recovers by re-reading the state file and re-probing.
 */

// Minimal MCP-like JSON-RPC handler — responds to tools/list and tools/call
function createMcpHandler(serverId: string, authToken?: string) {
  return (req: Request): Response | Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', version: '1.0.0' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname !== '/mcp' || req.method !== 'POST') {
      return new Response('Not Found', { status: 404 });
    }

    if (authToken !== undefined && req.headers.get('authorization') !== `Bearer ${authToken}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    return req.json().then((body: { id?: unknown; method?: string }) => {
      const result = { serverId, method: body.method };
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });
  };
}

function writeAuthConfig(tmpDir: string, authToken: string): void {
  const configDir = path.join(tmpDir, 'config', 'open-zk-kb');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), `server:\n  authToken: ${authToken}\n`);
}

function writeStateFile(stateDir: string, port: number, pid: number) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'server.json'),
    JSON.stringify({
      pid,
      port,
      host: '127.0.0.1',
      version: '1.0.0',
      startedAt: new Date().toISOString(),
    }),
  );
}

/** Send a JSON-RPC request to the proxy subprocess via stdin and read the response from stdout. */
async function sendJsonRpc(
  proc: { stdin: { write(data: string): void }; stdout: ReadableStream },
  reader: ReadableStreamDefaultReader<Uint8Array>,
  method: string,
  id: number,
): Promise<{ id: number; result?: unknown; error?: { code: number; message: string } }> {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) + '\n';
  proc.stdin.write(msg);

  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 500),
      ),
    ]);

    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }

    // Try to parse complete lines
    const newlineIdx = buffer.indexOf('\n');
    if (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      if (line.length > 0) {
        return JSON.parse(line);
      }
      buffer = buffer.slice(newlineIdx + 1);
    }

    if (done && buffer.trim().length > 0) {
      return JSON.parse(buffer.trim());
    }
  }
  throw new Error('Timed out waiting for response');
}

describe.skipIf(!INTEGRATION)('Stdio Bridge Self-Healing', () => {
  let tmpDir: string;
  let stateDir: string;
  let originalRuntimeDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozkb-bridge-test-'));
    stateDir = path.join(tmpDir, 'open-zk-kb');
    originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
  });

  afterEach(() => {
    if (originalRuntimeDir !== undefined) {
      process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
    } else {
      delete process.env.XDG_RUNTIME_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('forwards the configured bearer token while reconnecting to a restarted HTTP server', async () => {
    // Start first server
    const authToken = 'bridge-test-token';
    let server1: Server | null = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: createMcpHandler('server-1', authToken),
    });

    writeStateFile(stateDir, server1.port, process.pid);
    writeAuthConfig(tmpDir, authToken);

    const proc = Bun.spawn(
      ['bun', 'run', CLI_PATH, 'server'],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          XDG_RUNTIME_DIR: tmpDir,
          XDG_CONFIG_HOME: path.join(tmpDir, 'config'),
          XDG_DATA_HOME: path.join(tmpDir, 'data'),
          XDG_STATE_HOME: path.join(tmpDir, 'state'),
        },
      },
    );

    try {
      const reader = proc.stdout.getReader();
      await new Promise((r) => setTimeout(r, 300));

      // First request succeeds via server-1
      const resp1 = await sendJsonRpc(proc, reader, 'tools/list', 1);
      expect(resp1.id).toBe(1);
      expect(resp1.result).toBeDefined();
      expect((resp1.result as { serverId: string }).serverId).toBe('server-1');

      // Kill server-1 and immediately start server-2 on a new port.
      // The bridge's internal retry chain (retry → re-probe state file → reconnect)
      // should find server-2 without the user ever seeing an error.
      server1.stop(true);
      server1 = null;

      const server2 = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: createMcpHandler('server-2', authToken),
      });
      writeStateFile(stateDir, server2.port, process.pid);

      // The bridge retries internally — the user sees a successful response,
      // never the -32603 error.
      const resp2 = await sendJsonRpc(proc, reader, 'tools/list', 2);
      expect(resp2.result).toBeDefined();
      expect(resp2.error).toBeUndefined();
      expect((resp2.result as { serverId: string }).serverId).toBe('server-2');

      server2.stop(true);
    } finally {
      proc.stdin.end();
      proc.kill();
      if (server1) server1.stop(true);
    }
  }, 15000);
});

describe.skipIf(!INTEGRATION)('Stdio Bridge Local Fallback', () => {
  let tmpDir: string;
  let stateDir: string;
  let originalRuntimeDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozkb-local-test-'));
    stateDir = path.join(tmpDir, 'open-zk-kb');
    originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
  });

  afterEach(() => {
    if (originalRuntimeDir !== undefined) {
      process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
    } else {
      delete process.env.XDG_RUNTIME_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('processes locally with the configured bearer token when the shared server is gone', async () => {
    const authToken = 'local-fallback-test-token';
    // Start a mock server that the bridge will initially connect to
    let mockServer: Server | null = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: createMcpHandler('mock-server', authToken),
    });

    writeStateFile(stateDir, mockServer.port, process.pid);

    // Create a config.yaml with port: 0 so any background HTTP server
    // picks an ephemeral port (avoids collision with the real server).
    const configDir = path.join(tmpDir, 'config', 'open-zk-kb');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.yaml'),
      `server:\n  port: 0\n  host: "127.0.0.1"\n  authToken: ${authToken}\n`,
    );

    // Create data dir for SQLite
    fs.mkdirSync(path.join(tmpDir, 'data', 'open-zk-kb'), { recursive: true });

    const proc = Bun.spawn(
      ['bun', 'run', CLI_PATH, 'server'],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          XDG_RUNTIME_DIR: tmpDir,
          XDG_CONFIG_HOME: path.join(tmpDir, 'config'),
          XDG_DATA_HOME: path.join(tmpDir, 'data'),
          XDG_STATE_HOME: path.join(tmpDir, 'state'),
        },
      },
    );

    try {
      const reader = proc.stdout.getReader();
      await new Promise((r) => setTimeout(r, 300));

      // First request succeeds via mock server
      const resp1 = await sendJsonRpc(proc, reader, 'tools/list', 1);
      expect(resp1.id).toBe(1);
      expect(resp1.result).toBeDefined();

      // Kill mock server AND remove state file — server is truly gone
      mockServer.stop(true);
      mockServer = null;
      try { fs.unlinkSync(path.join(stateDir, 'server.json')); } catch { /* ok */ }

      // The bridge retries internally, finds no server, and falls back to
      // local in-process handling. The user sees a successful response.
      const resp2Promise = sendJsonRpc(proc, reader, 'tools/list', 2);
      const resp2 = await Promise.race([
        resp2Promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Local processing timed out')), 20000),
        ),
      ]);

      // The bridge handled the request in-process — no error
      expect(resp2.result).toBeDefined();
      expect(resp2.error).toBeUndefined();
    } finally {
      proc.stdin.end();
      proc.kill();
      if (mockServer) mockServer.stop(true);
    }
  }, 30000);
});