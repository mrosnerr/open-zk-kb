#!/usr/bin/env bun
// mcp-http-server.ts - Shared HTTP server for multi-session MCP access
// Runs a single process serving Streamable HTTP so multiple clients share one server.

import * as fs from 'fs';
import * as path from 'path';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { getConfig } from './config.js';
import { logToFile } from './logger.js';
import { createMcpServer, shutdownServer, ensureShutdownHandlers } from './mcp-server.js';
import { PKG_VERSION } from './version.js';

const config = getConfig();

// ── Runtime directory for PID/port discovery ──

const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp';
const SERVER_STATE_DIR = path.join(xdgRuntimeDir, 'open-zk-kb');
const SERVER_STATE_FILE = path.join(SERVER_STATE_DIR, 'server.json');

export interface ServerState {
  pid: number;
  port: number;
  host: string;
  version: string;
  startedAt: string;
}

function writeServerState(port: number, host: string): void {
  fs.mkdirSync(SERVER_STATE_DIR, { recursive: true });
  const state: ServerState = {
    pid: process.pid,
    port,
    host,
    version: PKG_VERSION,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SERVER_STATE_FILE, JSON.stringify(state, null, 2));
}

function removeServerState(): void {
  try {
    fs.unlinkSync(SERVER_STATE_FILE);
  } catch {
    // Already gone
  }
}

export function readServerState(): ServerState | null {
  try {
    const content = fs.readFileSync(SERVER_STATE_FILE, 'utf-8');
    const state = JSON.parse(content) as ServerState;

    // Validate the host is a loopback address — reject state files
    // pointing to non-local hosts to prevent traffic redirection attacks
    // when the state file lives in a world-writable directory like /tmp.
    const loopback = new Set(['127.0.0.1', '::1', 'localhost']);
    if (!loopback.has(state.host)) {
      logToFile('WARN', 'Server state file has non-loopback host, ignoring', {
        host: state.host,
        stateFile: SERVER_STATE_FILE,
      }, config);
      removeServerState();
      return null;
    }

    // On Unix, verify the state file is owned by the current user
    // to prevent other local users from planting a fake state file.
    if (process.platform !== 'win32') {
      try {
        const stat = fs.statSync(SERVER_STATE_FILE);
        if (stat.uid !== process.getuid!()) {
          logToFile('WARN', 'Server state file owned by different user, ignoring', {
            fileUid: stat.uid,
            processUid: process.getuid!(),
            stateFile: SERVER_STATE_FILE,
          }, config);
          removeServerState();
          return null;
        }
      } catch {
        // statSync failed — treat as missing
        return null;
      }
    }

    // Validate the process is still alive
    try {
      process.kill(state.pid, 0);
      return state;
    } catch {
      // Process is dead — stale state file
      removeServerState();
      return null;
    }
  } catch {
    return null;
  }
}

// ── HTTP Server ──

// Track active transports for cleanup
const activeTransports = new Set<Transport>();

async function handleMcpRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Health check endpoint
  if (url.pathname === '/health') {
    return new Response(JSON.stringify({ status: 'ok', version: PKG_VERSION }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Only handle /mcp endpoint
  if (url.pathname !== '/mcp') {
    return new Response('Not Found', { status: 404 });
  }

  // Create a fresh McpServer per request — the MCP SDK's Protocol rejects
  // connecting a second transport to the same instance, so stateless HTTP
  // mode needs one per request. Shared state (NoteRepository, embeddings)
  // lives in module-level singletons, not in the McpServer.
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  activeTransports.add(transport);
  transport.onclose = () => {
    activeTransports.delete(transport);
  };

  await server.connect(transport);
  const response = await transport.handleRequest(req);

  // Clean up: close transport and server for this request
  await transport.close().catch(() => {});
  await server.close();

  return response;
}

export interface StartHttpServerOptions {
  port?: number;
  host?: string;
}

export async function startHttpServer(options: StartHttpServerOptions = {}): Promise<void> {
  const port = options.port ?? config.server.port;
  const host = options.host ?? config.server.host;

  ensureShutdownHandlers();

  // Check if another instance is already running
  const existingState = readServerState();
  if (existingState) {
    logToFile('ERROR', 'Another HTTP server is already running', {
      pid: existingState.pid,
      port: existingState.port,
    }, config);
    throw new Error(`Another open-zk-kb HTTP server is already running (pid: ${existingState.pid}, port: ${existingState.port})`);
  }

  const httpServer = Bun.serve({
    port,
    hostname: host,
    fetch: handleMcpRequest,
  });
  const actualPort = httpServer.port as number;

  writeServerState(actualPort, host);
  logToFile('INFO', 'MCP HTTP server: started', {
    port: actualPort,
    host,
    version: PKG_VERSION,
  }, config);

  // Override shutdown to also clean up HTTP resources
  const originalShutdown = () => shutdownServer();
  const httpShutdown = () => {
    logToFile('INFO', 'MCP HTTP server: shutting down', {}, config);
    removeServerState();
    for (const transport of activeTransports) {
      transport.close().catch(() => {});
    }
    activeTransports.clear();
    httpServer.stop(true);
    originalShutdown();
  };

  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.on('SIGINT', httpShutdown);
  process.on('SIGTERM', httpShutdown);

  // Log the address for the user
  logToFile('INFO', `MCP HTTP server: listening on http://${host}:${httpServer.port}/mcp`, {}, config);
}
