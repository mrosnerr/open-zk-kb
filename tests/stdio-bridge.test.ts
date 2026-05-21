import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Server } from 'bun';

const CLI_PATH = path.resolve('dist/cli.js');
if (!fs.existsSync(CLI_PATH)) {
  throw new Error('dist/cli.js not found — run `bun run build` before `bun test`');
}

/**
 * Integration tests for the stdio→HTTP bridge self-healing behavior.
 *
 * These tests verify that when the HTTP server goes down and restarts,
 * the bridge proxy recovers by re-reading the state file and re-probing.
 */

// Minimal MCP-like JSON-RPC handler — responds to tools/list and tools/call
function createMcpHandler(serverId: string) {
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

    return req.json().then((body: { id?: unknown; method?: string }) => {
      const result = { serverId, method: body.method };
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });
  };
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

describe('Stdio Bridge Self-Healing', () => {
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

  it('should reconnect to a restarted HTTP server', async () => {
    // Start first server
    let server1: Server | null = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: createMcpHandler('server-1'),
    });

    writeStateFile(stateDir, server1.port, process.pid);

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
        fetch: createMcpHandler('server-2'),
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

describe('Stdio Bridge Local Fallback', () => {
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

  it('should process locally when shared server is gone', async () => {
    // Start a mock server that the bridge will initially connect to
    let mockServer: Server | null = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: createMcpHandler('mock-server'),
    });

    writeStateFile(stateDir, mockServer.port, process.pid);

    // Create a config.yaml with port: 0 so any background HTTP server
    // picks an ephemeral port (avoids collision with the real server).
    const configDir = path.join(tmpDir, 'config', 'open-zk-kb');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.yaml'),
      'server:\n  port: 0\n  host: "127.0.0.1"\n',
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