#!/usr/bin/env bun
// mcp-http-server.ts - Shared HTTP server for multi-session MCP access
// Runs a single process serving Streamable HTTP so multiple clients share one server.

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { getConfig } from './config.js';
import { logToFile } from './logger.js';
import { createMcpServer, shutdownServer, ensureShutdownHandlers } from './mcp-server.js';
import { PKG_VERSION } from './version.js';
import { readServerState, writeServerState, removeServerState } from './server-state.js';

// Re-export for consumers that imported from here previously
export { readServerState, type ServerState } from './server-state.js';

const config = getConfig();

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

  try {
    const response = await transport.handleRequest(req);
    return response;
  } finally {
    // Clean up: close transport and server for this request.
    // Must run even if handleRequest throws to avoid resource leaks.
    await transport.close().catch(() => {});
    await server.close();
  }
}

export interface StartHttpServerOptions {
  port?: number;
  host?: string;
}

export async function startHttpServer(options: StartHttpServerOptions = {}): Promise<void> {
  const port = options.port ?? config.server.port;
  const host = options.host ?? config.server.host;

  ensureShutdownHandlers();

  // Check if another instance is already running.
  // PID-alive alone is not sufficient — after an unclean shutdown, PID reuse
  // can make a stale state file block startup. Probe the health endpoint to
  // verify the process is actually serving before rejecting.
  const existingState = readServerState();
  if (existingState) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(
        `http://${existingState.host.includes(':') ? `[${existingState.host}]` : existingState.host}:${existingState.port}/health`,
        { signal: controller.signal },
      );
      clearTimeout(timeout);
      if (response.ok) {
        logToFile('ERROR', 'Another HTTP server is already running', {
          pid: existingState.pid,
          port: existingState.port,
        }, config);
        throw new Error(`Another open-zk-kb HTTP server is already running (pid: ${existingState.pid}, port: ${existingState.port})`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('already running')) {
        throw err; // Re-throw the "already running" error from above
      }
      // Health probe failed — the PID-alive process is not our server.
      // Remove the stale state file and proceed with startup.
      logToFile('INFO', 'Stale server state file detected (PID alive but not responding), removing', {
        pid: existingState.pid,
        port: existingState.port,
      }, config);
      removeServerState();
    }
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
