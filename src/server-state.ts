// server-state.ts — Lightweight server discovery for stdio bridge.
// This module MUST NOT import mcp-server.ts or any heavy dependencies
// (SDK, embeddings, NoteRepository). It's loaded by the bridge process
// which should stay small when it short-circuits to HTTP forwarding.

import * as fs from 'fs';
import * as path from 'path';
import { logToFile } from './logger.js';
import { getConfig } from './config.js';
import { PKG_VERSION } from './version.js';

const config = getConfig();

// ── Runtime directory for PID/port discovery ──

const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp';
export const SERVER_STATE_DIR = path.join(xdgRuntimeDir, 'open-zk-kb');
export const SERVER_STATE_FILE = path.join(SERVER_STATE_DIR, 'server.json');

export interface ServerState {
  pid: number;
  port: number;
  host: string;
  version: string;
  startedAt: string;
}

export function writeServerState(port: number, host: string): void {
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

export function removeServerState(): void {
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

    // Validate the host is loopback or a wildcard bind address — reject
    // state files pointing to non-local hosts to prevent traffic redirection
    // attacks when the state file lives in a world-writable directory like /tmp.
    const loopback = new Set(['127.0.0.1', '::1', 'localhost']);
    const wildcardBind = new Set(['0.0.0.0', '::']);
    if (!loopback.has(state.host) && !wildcardBind.has(state.host)) {
      logToFile('WARN', 'Server state file has non-local host, ignoring', {
        host: state.host,
        stateFile: SERVER_STATE_FILE,
      }, config);
      removeServerState();
      return null;
    }

    // Wildcard bind addresses (0.0.0.0, ::) listen on all interfaces but
    // must be reached via loopback for local probing.
    if (wildcardBind.has(state.host)) {
      state.host = '127.0.0.1';
    }

    // On Unix, verify the state file is owned by the current user
    // to prevent other local users from planting a fake state file.
    if (process.platform !== 'win32') {
      try {
        const stat = fs.statSync(SERVER_STATE_FILE);
        const currentUid = process.getuid?.();
        if (currentUid === undefined || stat.uid !== currentUid) {
          logToFile('WARN', 'Server state file owned by different user, ignoring', {
            fileUid: stat.uid,
            processUid: currentUid,
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
