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
import { NoteRepository, TELEMETRY_TOOL_NAMES } from '../src/storage/NoteRepository.js';
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
      OPEN_ZK_KB_TELEMETRY_ENV: process.env.OPEN_ZK_KB_TELEMETRY_ENV,
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

  it('reports a completed prior startup with bounded synthetic telemetry', async () => {
    createIsolatedEnv('telemetry:\n  enabled: true\n  share: true\n  id: "int-test-uuid"\n');
    process.env.OPEN_ZK_KB_TELEMETRY_ENV = 'test';

    const identifyingNamespace = 'synthetic-private-tenant';

    // First startup: write a completed session through the real repository API.
    const priorRepository = ctx.engine;
    priorRepository.recordSessionStart(
      'synthetic-unknown-client',
      '1.0.27',
      42,
      '1.3.0',
      true,
    );
    const priorSessionId = priorRepository.getSessionId();
    for (const toolName of TELEMETRY_TOOL_NAMES) {
      priorRepository.recordToolInvocation(
        toolName,
        undefined,
        undefined,
        `${identifyingNamespace}/claude-3-5-sonnet`,
      );
    }
    priorRepository.recordSessionEnd();
    priorRepository.close();

    // Second startup: use a distinct repository instance to drain the queue.
    ctx.engine = new NoteRepository(ctx.tempDir, { telemetryEnabled: true });

    const fetchCalls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (
      url: string | URL | Request,
      opts?: RequestInit,
    ) => {
      fetchCalls.push({
        url: url.toString(),
        body: JSON.parse(opts?.body as string),
      });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    // The current startup drains the completed prior startup's real SQLite queue.
    await reportPreviousSessions(ctx.engine);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://eu.i.posthog.com/batch/');
    const body = fetchCalls[0].body as Record<string, unknown>;
    const batch = body.batch as Array<Record<string, unknown>>;
    expect(batch).toHaveLength(1);
    expect(batch[0].event).toBe('session');

    const props = batch[0].properties as Record<string, unknown>;
    expect(props.client).toBe('other');
    expect(props.session_id).toBe(priorSessionId);
    expect(props.$lib_env).toBe('test');
    expect(props.$lib).toBe('open-zk-kb');

    const toolTotal = TELEMETRY_TOOL_NAMES.reduce((sum, toolName) => {
      expect(props[`tool_${toolName}`]).toBe(1);
      return sum + Number(props[`tool_${toolName}`]);
    }, 0);
    expect(TELEMETRY_TOOL_NAMES).toHaveLength(10);
    expect(props.total_invocations).toBe(10);
    expect(props.total_invocations).toBe(toolTotal);

    expect(props.models).toEqual(['claude']);
    expect(JSON.stringify(props.models)).not.toContain(identifyingNamespace);

    const db2 = new Database(dbPath(), { readonly: true });
    const row = db2
      .prepare('SELECT reported FROM sessions WHERE session_id = ?')
      .get(priorSessionId) as { reported: number };
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
