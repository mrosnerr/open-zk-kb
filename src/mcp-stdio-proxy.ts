// mcp-stdio-proxy.ts - Stdio proxy that delegates to a shared HTTP server when available
// Falls back to running the full server in-process when no HTTP server is detected.
// When bridging, this process has a tiny memory footprint — no SQLite, no ONNX model.

import { logToFile } from './logger.js';
import { getConfig } from './config.js';
import { readServerState } from './server-state.js';
import type { ServerState } from './server-state.js';

const config = getConfig();

/**
 * Probe whether the HTTP server is actually responding.
 * Returns the server state if healthy, null otherwise.
 */
async function probeHttpServer(state: ServerState): Promise<ServerState | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const hostForUrl = state.host.includes(':') ? `[${state.host}]` : state.host;
    const response = await fetch(`http://${hostForUrl}:${state.port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.ok) {
      return state;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read a complete JSON-RPC message from stdin.
 * MCP stdio uses newline-delimited JSON.
 */
async function* readStdinMessages(): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      try {
        yield JSON.parse(line);
      } catch {
        logToFile('WARN', 'Stdio proxy: failed to parse stdin line', { line: line.slice(0, 200) }, config);
      }
    }
  }
}

/**
 * Forward a JSON-RPC message to the HTTP server and return the response.
 */
export function buildMcpRequestHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  if (authToken !== undefined) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  return headers;
}

async function forwardToHttp(
  state: ServerState,
  message: unknown,
): Promise<unknown | null> {
  try {
    const hostForUrl = state.host.includes(':') ? `[${state.host}]` : state.host;
    const response = await fetch(`http://${hostForUrl}:${state.port}/mcp`, {
      method: 'POST',
      headers: buildMcpRequestHeaders(config.server.authToken),
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      logToFile('ERROR', 'Stdio proxy: HTTP server returned error', {
        status: response.status,
        statusText: response.statusText,
      }, config);
      return null;
    }

    // Response may be empty (for notifications)
    const text = await response.text();
    if (text.length === 0) return null;

    return JSON.parse(text);
  } catch (error) {
    logToFile('ERROR', 'Stdio proxy: failed to forward to HTTP', {
      error: error instanceof Error ? error.message : String(error),
    }, config);
    return null;
  }
}

export const READ_ONLY_TOOLS: Record<string, true> = {
  'knowledge-search': true,
  'knowledge-get': true,
  'knowledge-stats': true,
  'knowledge-overview': true,
  'knowledge-template': true,
};

export function isRetriableSingleRequest(req: unknown): boolean {
  if (req === null || typeof req !== 'object') return true;

  const jsonRpcReq = req as Record<string, unknown>;
  const method = jsonRpcReq.method;
  if (typeof method !== 'string') return true;

  if (method !== 'tools/call') return true;

  const params = jsonRpcReq.params;
  if (params === null || typeof params !== 'object') return false;

  const toolName = (params as Record<string, unknown>).name;
  return typeof toolName === 'string' && READ_ONLY_TOOLS[toolName] === true;
}

export function isRetriableRequest(req: unknown): boolean {
  if (!Array.isArray(req)) return isRetriableSingleRequest(req);
  return req.every(isRetriableSingleRequest);
}

export function isJsonRpcNotification(message: unknown): boolean {
  return message !== null
    && typeof message === 'object'
    && !('id' in (message as Record<string, unknown>));
}

export function isNotificationOnlyMessage(message: unknown): boolean {
  return Array.isArray(message)
    ? message.length > 0 && message.every(isJsonRpcNotification)
    : isJsonRpcNotification(message);
}


/**
 * Write a JSON-RPC response to stdout (newline-delimited).
 */
async function writeToStdout(message: unknown): Promise<void> {
  const data = JSON.stringify(message) + '\n';
  await Bun.write(Bun.stdout, data);
}

// Cache the dynamic import so we only load the heavy modules once.
let localHandler: ((req: Request) => Promise<Response>) | null = null;

/**
 * Process a JSON-RPC message through a local MCP server instance.
 * Dynamically imports the heavy modules (NoteRepository, ONNX, MCP SDK)
 * on first call so the bridge stays lightweight until actually needed.
 */
async function processLocally(message: unknown): Promise<unknown | null> {
  if (!localHandler) {
    logToFile('INFO', 'Stdio proxy: loading in-process MCP server', {}, config);
    const mod = await import('./mcp-http-server.js');
    localHandler = mod.handleMcpRequest;
  }

  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(message),
  });

  const resp = await localHandler(req);
  const text = await resp.text();
  return text.length > 0 ? JSON.parse(text) : null;
}

/**
 * Start an HTTP server in the background so other bridges can discover us.
 * Best-effort: if it fails (port race, etc.), we still serve locally.
 */
function startHttpServerBackground(): void {
  import('./mcp-http-server.js')
    .then(mod => mod.startHttpServer())
    .then(() => {
      const st = readServerState();
      logToFile('INFO', 'Stdio proxy: background HTTP server started', {
        pid: st?.pid,
        port: st?.port,
      }, config);
    })
    .catch(err => {
      // Another bridge won the race, or port in use — that's fine.
      logToFile('DEBUG', 'Stdio proxy: background HTTP server skipped', {
        error: err instanceof Error ? err.message : String(err),
      }, config);
    });
}

/**
 * Attempt to start as a stdio→HTTP bridge.
 * Returns true if the bridge was established, false if fallback is needed.
 */
export async function tryStdioBridge(): Promise<boolean> {
  let state = readServerState();
  if (!state) {
    return false;
  }

  const healthy = await probeHttpServer(state);
  if (!healthy) {
    logToFile('DEBUG', 'HTTP server state file exists but server not healthy, falling back to in-process', {}, config);
    return false;
  }

  logToFile('INFO', 'MCP stdio proxy: bridging to HTTP server', {
    pid: state.pid,
    port: state.port,
  }, config);

  // Track whether we've started a background HTTP server for other bridges.
  let httpStarted = false;

  try {
    // Run the message forwarding loop
    for await (const message of readStdinMessages()) {
      let response = await forwardToHttp(state, message);

      // Notifications (no `id`) are fire-and-forget — no response expected.
      // forwardToHttp returns null for both "empty body" (notification
      // success) and "transport failure", so we skip the recovery chain to
      // avoid re-executing notifications. A batch array where every element
      // lacks an `id` is also entirely fire-and-forget.
      const isNotification = isNotificationOnlyMessage(message);
      const canRetry = isRetriableRequest(message);

      // On failure, exhaust every recovery option before returning an error.
      // The user should never see -32603 if the server can be recovered.
      if (!isNotification && canRetry && response === null) {
        // 1. Immediate retry — handles transient network glitches.
        response = await forwardToHttp(state, message);
      }

      if (!isNotification && canRetry && response === null) {
        // 2. Re-read state file — maybe the server restarted on a new port/PID.
        const newState = readServerState();
        if (newState) {
          const newHealthy = await probeHttpServer(newState);
          if (newHealthy) {
            state = newHealthy;
            logToFile('INFO', 'Stdio proxy: reconnected to HTTP server', {
              pid: state.pid,
              port: state.port,
            }, config);
            response = await forwardToHttp(state, message);
          }
        }
      }

      if (!isNotification && canRetry && response === null) {
        // 3. No server anywhere — process locally. Every bridge can
        //    independently serve via the shared SQLite database (WAL mode).
        //    Multiple bridges handling requests in parallel is fine.
        try {
          response = await processLocally(message);
        } catch (err) {
          logToFile('ERROR', 'Stdio proxy: local fallback failed', {
            error: err instanceof Error ? err.message : String(err),
          }, config);
          response = null;
        }

        // Also start an HTTP server in the background (best-effort) so
        // other bridges can reconnect to us rather than all going local.
        if (!httpStarted) {
          httpStarted = true;
          startHttpServerBackground();
        }
      }

      if (response !== null) {
        await writeToStdout(response);
      } else if (Array.isArray(message)) {
        // Batch JSON-RPC: emit error responses for each request in the batch.
        // Notifications (no `id`) are omitted per spec.
        const errors = message
          .filter((m): m is Record<string, unknown> =>
            m !== null && typeof m === 'object' && 'id' in m)
          .map(m => ({
            jsonrpc: '2.0' as const,
            id: m.id,
            error: {
              code: -32603,
              message: 'HTTP bridge failed to forward request to server',
            },
          }));
        if (errors.length > 0) {
          await writeToStdout(errors);
        }
      } else if (
        message !== null &&
        typeof message === 'object' &&
        'id' in (message as Record<string, unknown>)
      ) {
        // Single JSON-RPC request: emit error response.
        const id = (message as Record<string, unknown>).id;
        await writeToStdout({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: canRetry
              ? 'HTTP bridge failed to forward request to server'
              : 'HTTP bridge failed before completing non-retriable request',
          },
        });
      }
      // Notifications (no `id`) — suppressing output is correct per JSON-RPC spec
    }

    // stdin closed — exit cleanly
    process.exit(0);
  } catch (error) {
    logToFile('WARN', 'MCP stdio proxy: bridge failed, falling back to in-process', {
      error: error instanceof Error ? error.message : String(error),
    }, config);
    return false;
  }

  return true;
}
