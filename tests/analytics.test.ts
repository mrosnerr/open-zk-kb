import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _resetConfigCache, isTelemetryShareConfigured } from '../src/config.js';
import {
  reportPreviousSessions,
  getOrCreateAnalyticsId,
  isSharingEnabled,
} from '../src/analytics.js';
import type { UnreportedSession } from '../src/storage/NoteRepository.js';

describe('analytics', () => {
  const tempDirs: string[] = [];
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      DO_NOT_TRACK: process.env.DO_NOT_TRACK,
    };
  });

  afterEach(() => {
    _resetConfigCache();
    for (const [key, val] of Object.entries(envSnapshot)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createIsolatedEnv() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-analytics-test-'));
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
    _resetConfigCache();

    return {
      rootDir,
      configPath: path.join(configDir, 'config.yaml'),
      configDir,
    };
  }

  function writeConfig(configPath: string, yaml: string) {
    fs.writeFileSync(configPath, yaml, 'utf-8');
    _resetConfigCache();
  }

  function createMockRepo(sessions: UnreportedSession[] = []) {
    const reportedIds: string[][] = [];
    return {
      repo: {
        getUnreportedSessions: (_limit?: number) => sessions,
        markSessionsReported: (ids: string[]) => { reportedIds.push(ids); },
      },
      reportedIds,
    };
  }

  function createTestSession(overrides: Partial<UnreportedSession> = {}): UnreportedSession {
    return {
      session_id: 'test-session-123',
      client: 'claude-code',
      client_version: '1.0.27',
      started_at: Date.now() - 60000,
      ended_at: Date.now() - 30000,
      vault_size: 42,
      version: '1.3.0',
      os_platform: 'darwin',
      tool_counts: { search: 5, store: 2 },
      total_invocations: 7,
      models: ['claude-sonnet-4'],
      ...overrides,
    };
  }

  // ── Config Resolution ──

  describe('telemetry config resolution', () => {
    it('defaults share=false and id=undefined when no telemetry section', async () => {
      createIsolatedEnv();
      const configModule = await import(`../src/config.js?test=${Date.now()}-${Math.random()}`);
      const cfg = configModule.getConfig();
      expect(cfg.telemetry.enabled).toBe(false);
      expect(cfg.telemetry.share).toBe(false);
      expect(cfg.telemetry.id).toBeUndefined();
    });

    it('defaults share=false when only enabled is set', async () => {
      const env = createIsolatedEnv();
      const configModule = await import(`../src/config.js?test=${Date.now()}-${Math.random()}`);
      fs.writeFileSync(
        path.join(env.configDir, 'config.yaml'),
        'telemetry:\n  enabled: true\n',
        'utf-8',
      );
      const cfg = configModule.getConfig();
      expect(cfg.telemetry.enabled).toBe(true);
      expect(cfg.telemetry.share).toBe(false);
      expect(cfg.telemetry.id).toBeUndefined();
    });

    it('resolves enabled+share from config', async () => {
      const env = createIsolatedEnv();
      const configModule = await import(`../src/config.js?test=${Date.now()}-${Math.random()}`);
      fs.writeFileSync(
        path.join(env.configDir, 'config.yaml'),
        'telemetry:\n  enabled: true\n  share: true\n',
        'utf-8',
      );
      const cfg = configModule.getConfig();
      expect(cfg.telemetry.enabled).toBe(true);
      expect(cfg.telemetry.share).toBe(true);
    });

    it('resolves full config with id', async () => {
      const env = createIsolatedEnv();
      const configModule = await import(`../src/config.js?test=${Date.now()}-${Math.random()}`);
      fs.writeFileSync(
        path.join(env.configDir, 'config.yaml'),
        'telemetry:\n  enabled: true\n  share: true\n  id: "abc-123"\n',
        'utf-8',
      );
      const cfg = configModule.getConfig();
      expect(cfg.telemetry.enabled).toBe(true);
      expect(cfg.telemetry.share).toBe(true);
      expect(cfg.telemetry.id).toBe('abc-123');
    });

    it('share without enabled still resolves (share=true, enabled=false)', async () => {
      const env = createIsolatedEnv();
      const configModule = await import(`../src/config.js?test=${Date.now()}-${Math.random()}`);
      fs.writeFileSync(
        path.join(env.configDir, 'config.yaml'),
        'telemetry:\n  share: true\n',
        'utf-8',
      );
      const cfg = configModule.getConfig();
      expect(cfg.telemetry.enabled).toBe(false);
      expect(cfg.telemetry.share).toBe(true);
    });
  });

  // ── PII Snapshot Tests ──

  describe('PII snapshot — event properties are allowlisted', () => {
    it('session event has only allowed keys', () => {
      const allowedKeys = [
        'client', 'client_version', 'duration_ms', 'models', 'os_platform',
        'session_id', 'tool_maintain', 'tool_mine', 'tool_search',
        'tool_store', 'tool_template', 'total_invocations', 'vault_size', 'version',
      ];
      const properties = {
        client: 'claude-code',
        client_version: '1.0.27',
        session_id: 'abc',
        version: '1.3.0',
        os_platform: 'darwin',
        vault_size: 42,
        duration_ms: 30000,
        total_invocations: 8,
        tool_search: 5,
        tool_store: 2,
        tool_maintain: 1,
        tool_mine: 0,
        tool_template: 0,
        models: ['claude-sonnet-4'],
      };
      expect(Object.keys(properties).sort()).toEqual(allowedKeys);
    });
  });

  // ── isSharingEnabled ──

  describe('isSharingEnabled', () => {
    it('returns false when share is false', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: false\n');
      expect(isSharingEnabled()).toBe(false);
    });

    it('returns false when enabled is false', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: false\n  share: true\n');
      expect(isSharingEnabled()).toBe(false);
    });

    it('returns true when both enabled and share are true', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n');
      expect(isSharingEnabled()).toBe(true);
    });

    it('returns false when DO_NOT_TRACK=1 and share is not explicitly configured', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n');
      process.env.DO_NOT_TRACK = '1';
      expect(isSharingEnabled()).toBe(false);
    });

    it('honors explicit share: true even when DO_NOT_TRACK=1', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n');
      process.env.DO_NOT_TRACK = '1';
      expect(isSharingEnabled()).toBe(true);
    });
  });

  // ── reportPreviousSessions ──

  describe('reportPreviousSessions', () => {
    it('sends one session event per unreported session with flattened tool counts', async () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n  id: "test-uuid"\n');

      const session = createTestSession();
      const { repo, reportedIds } = createMockRepo([session]);

      const calls: { url: string; body: unknown }[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request, opts?: RequestInit) => {
        calls.push({ url: url.toString(), body: JSON.parse(opts?.body as string) });
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      try {
        await reportPreviousSessions(repo);

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toContain('/batch/');

        const body = calls[0].body as Record<string, unknown>;
        const batch = body.batch as Array<Record<string, unknown>>;
        expect(batch).toHaveLength(1); // One event per session

        const event = batch[0];
        expect(event.event).toBe('session');
        expect(event.distinct_id).toBe('test-uuid');
        expect(event.timestamp).toBeDefined();
        expect(typeof event.timestamp).toBe('string');

        const props = event.properties as Record<string, unknown>;
        // Dimensions
        expect(props.client).toBe('claude-code');
        expect(props.client_version).toBe('1.0.27');
        expect(props.version).toBe('1.3.0');
        expect(props.os_platform).toBe('darwin');
        // Metrics
        expect(props.vault_size).toBe(42);
        expect(props.duration_ms).toBeGreaterThan(0);
        expect(props.total_invocations).toBe(7);
        expect(props.tool_search).toBe(5);
        expect(props.tool_store).toBe(2);
        expect(props.tool_maintain).toBe(0);
        expect(props.tool_mine).toBe(0);
        expect(props.tool_template).toBe(0);
        // Correlation
        expect(props.session_id).toBe('test-session-123');
        // Models
        expect(props.models).toEqual(['claude-sonnet-4']);
        // Metadata
        expect(props.$lib).toBe('open-zk-kb');
        expect(props.$geoip_disable).toBe(true);

        // Should mark reported
        expect(reportedIds).toHaveLength(1);
        expect(reportedIds[0]).toEqual(['test-session-123']);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('sends multiple session events for multiple unreported sessions', async () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n  id: "test-uuid"\n');

      const sessions = [
        createTestSession({ session_id: 'sess-1', client: 'claude-code' }),
        createTestSession({ session_id: 'sess-2', client: 'cursor' }),
      ];
      const { repo, reportedIds } = createMockRepo(sessions);

      const calls: { body: unknown }[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: string | URL | Request, opts?: RequestInit) => {
        calls.push({ body: JSON.parse(opts?.body as string) });
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      try {
        await reportPreviousSessions(repo);

        const batch = (calls[0].body as Record<string, unknown>).batch as Array<Record<string, unknown>>;
        expect(batch).toHaveLength(2);
        expect(batch[0].event).toBe('session');
        expect(batch[1].event).toBe('session');
        expect((batch[0].properties as Record<string, unknown>).client).toBe('claude-code');
        expect((batch[1].properties as Record<string, unknown>).client).toBe('cursor');

        expect(reportedIds[0]).toEqual(['sess-1', 'sess-2']);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('does not mark sessions reported on non-2xx response', async () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n  id: "test-uuid"\n');

      const { repo, reportedIds } = createMockRepo([createTestSession()]);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return new Response('rate limited', { status: 429 });
      }) as typeof fetch;

      try {
        await reportPreviousSessions(repo);
        expect(reportedIds).toHaveLength(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('does not mark sessions reported on fetch failure', async () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n  id: "test-uuid"\n');

      const { repo, reportedIds } = createMockRepo([createTestSession()]);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error('Network error');
      }) as typeof fetch;

      try {
        await reportPreviousSessions(repo);
        expect(reportedIds).toHaveLength(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('is no-op when sharing is disabled', async () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: false\n');

      const { repo, reportedIds } = createMockRepo([createTestSession()]);

      let fetchCalled = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      try {
        await reportPreviousSessions(repo);
        expect(fetchCalled).toBe(false);
        expect(reportedIds).toHaveLength(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('is no-op when no unreported sessions', async () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n');

      const { repo } = createMockRepo([]);

      let fetchCalled = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      try {
        await reportPreviousSessions(repo);
        expect(fetchCalled).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('handles null duration_ms when session has no ended_at', async () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n  id: "test-uuid"\n');

      const session = createTestSession({ ended_at: null });
      const { repo } = createMockRepo([session]);

      const calls: { body: unknown }[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: string | URL | Request, opts?: RequestInit) => {
        calls.push({ body: JSON.parse(opts?.body as string) });
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      try {
        await reportPreviousSessions(repo);
        const batch = (calls[0].body as Record<string, unknown>).batch as Array<Record<string, unknown>>;
        const props = batch[0].properties as Record<string, unknown>;
        expect(props.duration_ms).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('defaults missing tool counts to zero', async () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n  id: "test-uuid"\n');

      const session = createTestSession({ tool_counts: {}, total_invocations: 0, models: [] });
      const { repo } = createMockRepo([session]);

      const calls: { body: unknown }[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: string | URL | Request, opts?: RequestInit) => {
        calls.push({ body: JSON.parse(opts?.body as string) });
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      try {
        await reportPreviousSessions(repo);
        const batch = (calls[0].body as Record<string, unknown>).batch as Array<Record<string, unknown>>;
        const props = batch[0].properties as Record<string, unknown>;
        expect(props.tool_search).toBe(0);
        expect(props.tool_store).toBe(0);
        expect(props.tool_maintain).toBe(0);
        expect(props.tool_mine).toBe(0);
        expect(props.tool_template).toBe(0);
        expect(props.total_invocations).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('includes $lib_env and $lib_version in payloads', async () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n  id: "meta-test"\n');

      const { repo } = createMockRepo([createTestSession()]);

      const calls: { body: unknown }[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: string | URL | Request, opts?: RequestInit) => {
        calls.push({ body: JSON.parse(opts?.body as string) });
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      try {
        await reportPreviousSessions(repo);
        const batch = (calls[0].body as Record<string, unknown>).batch as Array<Record<string, unknown>>;
        const props = batch[0].properties as Record<string, unknown>;
        expect(props.$lib).toBe('open-zk-kb');
        expect(props.$lib_version).toBeDefined();
        expect(props.$lib_env).toBeDefined();
        expect(['dev', 'production']).toContain(props.$lib_env);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ── getOrCreateAnalyticsId ──

  describe('getOrCreateAnalyticsId', () => {
    it('generates a UUID and persists to config', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n');

      const id = getOrCreateAnalyticsId();
      expect(id).toMatch(/^[0-9a-f]{8}-/);

      const content = fs.readFileSync(env.configPath, 'utf-8');
      expect(content).toContain(id);
    });

    it('reuses existing id from config', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n  id: "existing-uuid"\n');

      const id = getOrCreateAnalyticsId();
      expect(id).toBe('existing-uuid');
    });

    it('handles malformed telemetry section gracefully', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry: false\n');

      const id = getOrCreateAnalyticsId();
      expect(id).toMatch(/^[0-9a-f]{8}-/);
    });

    it('handles missing config file gracefully', () => {
      createIsolatedEnv();

      const id = getOrCreateAnalyticsId();
      expect(id).toMatch(/^[0-9a-f]{8}-/);
    });

    it('survives config write failure', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n');

      fs.chmodSync(path.dirname(env.configPath), 0o444);

      try {
        const id = getOrCreateAnalyticsId();
        expect(id).toMatch(/^[0-9a-f]{8}-/);
      } finally {
        fs.chmodSync(path.dirname(env.configPath), 0o755);
      }
    });
  });

  // ── isTelemetryShareConfigured ──

  describe('isTelemetryShareConfigured', () => {
    it('returns false when config file does not exist', () => {
      createIsolatedEnv();
      expect(isTelemetryShareConfigured()).toBe(false);
    });

    it('returns false when telemetry section is missing', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'logLevel: INFO\n');
      expect(isTelemetryShareConfigured()).toBe(false);
    });

    it('returns false when share key is absent', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n');
      expect(isTelemetryShareConfigured()).toBe(false);
    });

    it('returns true when share is explicitly true', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n');
      expect(isTelemetryShareConfigured()).toBe(true);
    });

    it('returns true when share is explicitly false', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: false\n');
      expect(isTelemetryShareConfigured()).toBe(true);
    });
  });

  // ── DO_NOT_TRACK override semantics ──

  describe('DO_NOT_TRACK override semantics', () => {
    it('DO_NOT_TRACK blocks when share is defaulted (not in config)', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n');
      process.env.DO_NOT_TRACK = '1';
      expect(isSharingEnabled()).toBe(false);
    });

    it('explicit share: true overrides DO_NOT_TRACK', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: true\n');
      process.env.DO_NOT_TRACK = '1';
      expect(isSharingEnabled()).toBe(true);
    });

    it('explicit share: false still blocks regardless of DO_NOT_TRACK', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: false\n');
      process.env.DO_NOT_TRACK = '1';
      expect(isSharingEnabled()).toBe(false);
    });

    it('explicit share: false blocks even without DO_NOT_TRACK', () => {
      const env = createIsolatedEnv();
      writeConfig(env.configPath, 'telemetry:\n  enabled: true\n  share: false\n');
      expect(isSharingEnabled()).toBe(false);
    });
  });
});
