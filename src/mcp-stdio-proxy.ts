// mcp-stdio-proxy.ts - Stdio proxy that delegates to a shared HTTP server when available
// Falls back to running the full server in-process when no HTTP server is detected.
// When bridging, this process has a tiny memory footprint — no SQLite, no ONNX model.

import { logToFile } from './logger.js';
import { getConfig } from './config.js';
import { readServerState } from './mcp-http-server.js';
import type { ServerState } from './mcp-http-server.js';

const config = getConfig();

/**
 * Probe whether the HTTP server is actually responding.
 * Returns the server state if healthy, null otherwise.
 */
async function probeHttpServer(state: ServerState): Promise<ServerState | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`http://${state.host}:${state.port}/health`, {
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
async function forwardToHttp(
  state: ServerState,
  message: unknown,
): Promise<unknown | null> {
  try {
    const response = await fetch(`http://${state.host}:${state.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
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

/**
 * Write a JSON-RPC response to stdout (newline-delimited).
 */
function writeToStdout(message: unknown): void {
  const data = JSON.stringify(message) + '\n';
  Bun.write(Bun.stdout, data);
}

/**
 * Attempt to start as a stdio→HTTP bridge.
 * Returns true if the bridge was established, false if fallback is needed.
 */
export async function tryStdioBridge(): Promise<boolean> {
  const state = readServerState();
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

  try {
    // Run the message forwarding loop
    for await (const message of readStdinMessages()) {
      const response = await forwardToHttp(state, message);
      if (response !== null) {
        writeToStdout(response);
      }
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
