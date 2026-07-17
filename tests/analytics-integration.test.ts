/**
 * Integration tests for analytics pipeline.
 * Verifies startup reporting with real NoteRepository.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Database } from 'bun:sqlite';
import { _resetConfigCache } from '../src/config.js';
import { reportPreviousSessions } from '../src/analytics.js';
import { createTestHarness, cleanupTestHarness } from './harness.js';
import type { TestContext } from './harness.js';

describe('analytics integration', () => {
  let ctx: TestContext;
  const tempDirs: string[] = [];
  let envSnapshot: Record<string, string | undefined>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    envSnapshot = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      DO_NOT_TRACK: process.env.DO_NOT_TRACK,
    };
    ctx = createTestHarness({ telemetryEnabled: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanupTestHarness(ctx);
    _resetConfigCache();
    for (const [key, val] of Object.entries(envSnapshot)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createIsolatedEnv(configYaml: string) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-analytics-int-'));
    const configDir = path.join(rootDir, 'xdg-config', 'open-zk-kb');
    const dataDir = path.join(rootDir, 'xdg-data');
    const homeDir = path.join(rootDir, 'home');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    tempDirs.push(rootDir);

    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = path.join(rootDir, 'xdg-config');
    process.env.XDG_DATA_HOME = dataDir;
    delete process.env.DO_NOT_TRACK;

    fs.writeFileSync(path.join(configDir, 'config.yaml'), configYaml, 'utf-8');
    _resetConfigCache();
  }

  function dbPath(): string {
    return path.join(ctx.tempDir, '.index', 'knowledge.db');
  }

  it('reports previous session as a single session event with flattened tool counts', async () => {
    createIsolatedEnv('telemetry:\n  enabled: true\n  share: true\n  id: "int-test-uuid"\n');

    const db = new Database(dbPath());
    db.run(
      'INSERT INTO sessions (session_id, client, client_version, started_at, ended_at, vault_size, version, os_platform, reported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'prev-session-1', 'claude-code', '1.0.27', Date.now() - 120000, Date.now() - 60000, 42, '1.3.0', 'darwin', 0,
    );
    db.run('INSERT INTO tool_telemetry (session_id, tool_name, timestamp) VALUES (?, ?, ?)', 'prev-session-1', 'search', Date.now() - 100000);
    db.run('INSERT INTO tool_telemetry (session_id, tool_name, timestamp) VALUES (?, ?, ?)', 'prev-session-1', 'search', Date.now() - 90000);
    db.run('INSERT INTO tool_telemetry (session_id, tool_name, timestamp) VALUES (?, ?, ?)', 'prev-session-1', 'store', Date.now() - 80000);
    db.close();

    const fetchCalls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, opts?: RequestInit) => {
      fetchCalls.push({ url: url.toString(), body: JSON.parse(opts?.body as string) });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await reportPreviousSessions(ctx.engine);

    // One batch POST with one session event
    expect(fetchCalls).toHaveLength(1);
    const body = fetchCalls[0].body as Record<string, unknown>;
    const batch = body.batch as Array<Record<string, unknown>>;
    expect(batch).toHaveLength(1);

    const event = batch[0];
    expect(event.event).toBe('session');

    const props = event.properties as Record<string, unknown>;
    expect(props.client).toBe('claude-code');
    expect(props.session_id).toBe('prev-session-1');
    expect(props.vault_size).toBe(42);
    expect(props.os_platform).toBe('darwin');
    expect(props.tool_search).toBe(2);
    expect(props.tool_store).toBe(1);
    expect(props.tool_maintain).toBe(0);
    expect(props.total_invocations).toBe(3);
    expect(props.$lib).toBe('open-zk-kb');

    // Verify session is marked reported
    const db2 = new Database(dbPath(), { readonly: true });
    const row = db2.prepare('SELECT reported FROM sessions WHERE session_id = ?').get('prev-session-1') as { reported: number };
    db2.close();
    expect(row.reported).toBe(1);
  });

  it('zero fetch calls when share=false', async () => {
    createIsolatedEnv('telemetry:\n  enabled: true\n  share: false\n');

    const db = new Database(dbPath());
    db.run(
      'INSERT INTO sessions (session_id, client, started_at, vault_size, version, os_platform, reported) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'prev-session', 'cursor', Date.now() - 60000, 10, '1.3.0', 'linux', 0,
    );
    db.close();

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await reportPreviousSessions(ctx.engine);
    expect(fetchCalled).toBe(false);

    const db2 = new Database(dbPath(), { readonly: true });
    const row = db2.prepare('SELECT reported FROM sessions WHERE session_id = ?').get('prev-session') as { reported: number };
    db2.close();
    expect(row.reported).toBe(0);
  });

  it('sessions remain unreported on network failure', async () => {
    createIsolatedEnv('telemetry:\n  enabled: true\n  share: true\n  id: "test"\n');

    const db = new Database(dbPath());
    db.run(
      'INSERT INTO sessions (session_id, client, started_at, vault_size, version, os_platform, reported) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'prev-session', 'claude-code', Date.now() - 60000, 5, '1.3.0', 'darwin', 0,
    );
    db.close();

    globalThis.fetch = (async () => {
      throw new Error('Network error');
    }) as typeof fetch;

    await reportPreviousSessions(ctx.engine);

    const db2 = new Database(dbPath(), { readonly: true });
    const row = db2.prepare('SELECT reported FROM sessions WHERE session_id = ?').get('prev-session') as { reported: number };
    db2.close();
    expect(row.reported).toBe(0);
  });
});
