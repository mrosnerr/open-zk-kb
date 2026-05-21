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

export async function handleMcpRequest(req: Request): Promise<Response> {
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

  // Top-level error isolation: any throw here MUST return an HTTP response,
  // never propagate to Bun.serve() where it would crash the process.
  let server: ReturnType<typeof createMcpServer> | undefined;
  let transport: WebStandardStreamableHTTPServerTransport | undefined;
  // Clone request so we can extract the JSON-RPC id in the error path
  // (transport.handleRequest() consumes the original body stream).
  const reqForId = req.clone();
  try {
    // Create a fresh McpServer per request — the MCP SDK's Protocol rejects
    // connecting a second transport to the same instance, so stateless HTTP
    // mode needs one per request. Shared state (NoteRepository, embeddings)
    // lives in module-level singletons, not in the McpServer.
    server = createMcpServer();
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    activeTransports.add(transport);
    transport.onclose = () => {
      activeTransports.delete(transport!);
    };

    await server.connect(transport);

    const response = await transport.handleRequest(req);
    return response;
  } catch (error) {
    logToFile('ERROR', 'HTTP handler: request failed', {
      error: error instanceof Error ? error.message : String(error),
      method: req.method,
      path: url.pathname,
    }, config);
    // Best-effort id extraction from the cloned request.
    let requestId: unknown = null;
    try {
      const body = await reqForId.json() as Record<string, unknown>;
      requestId = body.id ?? null;
    } catch { /* body wasn't valid JSON */ }
    // Return a JSON-RPC internal error so the bridge/client gets a
    // parseable response rather than a connection reset. HTTP 200 is
    // intentional — non-2xx causes the bridge to treat this as a
    // transport failure rather than reading the JSON-RPC error body.
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32603, message: 'Internal server error' },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } finally {
    // Clean up: close transport and server for this request.
    // Must run even if handleRequest throws to avoid resource leaks.
    if (transport) {
      activeTransports.delete(transport);
      await transport.close().catch(() => {});
    }
    if (server) {
      await server.close().catch(() => {});
    }
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

  // Override shutdown to also clean up HTTP resources.
  // 1. Remove state file immediately so new bridges don't try to connect.
  // 2. Stop accepting new connections (stop(false) = graceful).
  // 3. Wait for in-flight requests to complete (up to 5s).
  // 4. Force-close any stragglers and exit.
  const originalShutdown = () => shutdownServer();
  const httpShutdown = () => {
    logToFile('INFO', 'MCP HTTP server: shutting down', {
      activeRequests: activeTransports.size,
    }, config);

    // Remove state file first — prevents new bridges from connecting
    // to a server that's about to die.
    removeServerState();

    // Stop accepting new connections but let in-flight requests finish.
    httpServer.stop(false);

    // Give in-flight requests up to 5 seconds to complete.
    const DRAIN_TIMEOUT_MS = 5000;
    const drainStart = Date.now();
    const drainInterval = setInterval(() => {
      if (activeTransports.size === 0 || Date.now() - drainStart > DRAIN_TIMEOUT_MS) {
        clearInterval(drainInterval);
        if (activeTransports.size > 0) {
          logToFile('WARN', 'HTTP server: force-closing remaining transports', {
            remaining: activeTransports.size,
          }, config);
          for (const transport of activeTransports) {
            transport.close().catch(() => {});
          }
          activeTransports.clear();
        }
        httpServer.stop(true);
        originalShutdown();
      }
    }, 100);
  };

  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.on('SIGINT', httpShutdown);
  process.on('SIGTERM', httpShutdown);

  // Crash safety: survive unhandled exceptions/rejections instead of dying.
  // The per-request try/catch in handleMcpRequest covers normal operation,
  // but module-level errors (e.g. in lazy singleton init) can still escape.
  // Log and continue — the server is more valuable alive with a logged error
  // than dead with a clean stack trace.
  process.on('uncaughtException', (error) => {
    logToFile('ERROR', 'HTTP server: uncaught exception (survived)', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }, config);
  });
  process.on('unhandledRejection', (reason) => {
    logToFile('ERROR', 'HTTP server: unhandled rejection (survived)', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    }, config);
  });

  // Clean up state file on any exit path — covers scenarios where
  // SIGINT/SIGTERM handlers don't fire (e.g. Bun internal crash, OOM kill
  // recovery after the kernel sends SIGKILL to a child but not the parent).
  process.on('exit', () => {
    try { removeServerState(); } catch { /* best effort */ }
  });

  // Log the address for the user
  logToFile('INFO', `MCP HTTP server: listening on http://${host}:${httpServer.port}/mcp`, {}, config);
}
