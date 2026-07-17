import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as path from 'path';
import { createTestHarness, cleanupTestHarness } from './harness.js';
import type { TestContext } from './harness.js';

describe('session tracking', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness({ telemetryEnabled: true });
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
  });

  function dbPath(): string {
    return path.join(ctx.tempDir, '.index', 'knowledge.db');
  }

  function getDb(): Database {
    return new Database(dbPath(), { readonly: true });
  }

  describe('getSessionId', () => {
    it('returns a UUID string', () => {
      const id = ctx.engine.getSessionId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('recordSessionStart', () => {
    it('inserts a row with correct fields', () => {
      ctx.engine.recordSessionStart('claude-code', '1.0.27', 42, '1.3.0');

      const db = getDb();
      const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(ctx.engine.getSessionId()) as Record<string, unknown>;
      db.close();

      expect(row).toBeDefined();
      expect(row.client).toBe('claude-code');
      expect(row.client_version).toBe('1.0.27');
      expect(row.vault_size).toBe(42);
      expect(row.version).toBe('1.3.0');
      expect(row.reported).toBe(0);
      expect(row.started_at).toBeGreaterThan(0);
      expect(row.ended_at).toBeNull();
      expect(row.os_platform).toBe(process.platform);
    });

    it('handles null client_version', () => {
      ctx.engine.recordSessionStart('unknown', null, 0, '1.3.0');

      const db = getDb();
      const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(ctx.engine.getSessionId()) as Record<string, unknown>;
      db.close();

      expect(row.client).toBe('unknown');
      expect(row.client_version).toBeNull();
    });
  });

  describe('recordSessionEnd', () => {
    it('updates ended_at for the current session', () => {
      ctx.engine.recordSessionStart('cursor', '0.44', 10, '1.3.0');
      ctx.engine.recordSessionEnd();

      const db = getDb();
      const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(ctx.engine.getSessionId()) as Record<string, unknown>;
      db.close();

      expect(row.ended_at).toBeGreaterThan(0);
      expect(row.ended_at as number).toBeGreaterThanOrEqual(row.started_at as number);
    });

    it('does not error when no session row exists', () => {
      // No recordSessionStart called — should silently succeed
      expect(() => ctx.engine.recordSessionEnd()).not.toThrow();
    });
  });

  describe('getUnreportedSessions', () => {
    it('returns sessions with reported=0, excluding current session', () => {
      // Simulate a previous session by inserting directly
      const db = new Database(dbPath());
      db.run(
        'INSERT INTO sessions (session_id, client, client_version, started_at, ended_at, vault_size, version, reported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        'prev-session-1', 'claude-code', '1.0.27', Date.now() - 60000, Date.now() - 30000, 42, '1.3.0', 0,
      );
      db.run(
        'INSERT INTO sessions (session_id, client, client_version, started_at, ended_at, vault_size, version, reported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        'prev-session-2', 'cursor', '0.44', Date.now() - 120000, Date.now() - 90000, 10, '1.2.0', 0,
      );
      // Also insert a reported session — should not be returned
      db.run(
        'INSERT INTO sessions (session_id, client, client_version, started_at, ended_at, vault_size, version, reported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        'prev-session-3', 'windsurf', null, Date.now() - 180000, Date.now() - 150000, 5, '1.1.0', 1,
      );
      db.close();

      const sessions = ctx.engine.getUnreportedSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].session_id).toBe('prev-session-1'); // Most recent first
      expect(sessions[1].session_id).toBe('prev-session-2');
    });

    it('joins with tool_telemetry for tool_counts', () => {
      const db = new Database(dbPath());
      db.run(
        'INSERT INTO sessions (session_id, client, started_at, ended_at, vault_size, version, reported) VALUES (?, ?, ?, ?, ?, ?, ?)',
        'prev-session', 'claude-code', Date.now() - 60000, Date.now() - 30000, 42, '1.3.0', 0,
      );
      db.run('INSERT INTO tool_telemetry (session_id, tool_name, timestamp, model) VALUES (?, ?, ?, ?)', 'prev-session', 'search', Date.now() - 50000, 'claude-sonnet-4');
      db.run('INSERT INTO tool_telemetry (session_id, tool_name, timestamp, model) VALUES (?, ?, ?, ?)', 'prev-session', 'search', Date.now() - 45000, 'claude-sonnet-4');
      db.run('INSERT INTO tool_telemetry (session_id, tool_name, timestamp, model) VALUES (?, ?, ?, ?)', 'prev-session', 'store', Date.now() - 40000, 'gpt-4o');
      db.close();

      const sessions = ctx.engine.getUnreportedSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].tool_counts).toEqual({ search: 2, store: 1 });
      expect(sessions[0].total_invocations).toBe(3);
      expect(sessions[0].models.sort()).toEqual(['claude-sonnet-4', 'gpt-4o']);
    });

    it('returns empty tool_counts when no tool_telemetry rows exist', () => {
      const db = new Database(dbPath());
      db.run(
        'INSERT INTO sessions (session_id, client, started_at, ended_at, vault_size, version, reported) VALUES (?, ?, ?, ?, ?, ?, ?)',
        'prev-session', 'cursor', Date.now() - 60000, Date.now() - 30000, 10, '1.3.0', 0,
      );
      db.close();

      const sessions = ctx.engine.getUnreportedSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].tool_counts).toEqual({});
      expect(sessions[0].total_invocations).toBe(0);
      expect(sessions[0].models).toEqual([]);
    });

    it('respects limit parameter', () => {
      const db = new Database(dbPath());
      for (let i = 0; i < 10; i++) {
        db.run(
          'INSERT INTO sessions (session_id, client, started_at, vault_size, version, reported) VALUES (?, ?, ?, ?, ?, ?)',
          `prev-session-${i}`, 'test', Date.now() - (i * 10000), 0, '1.0.0', 0,
        );
      }
      db.close();

      const sessions = ctx.engine.getUnreportedSessions(3);
      expect(sessions).toHaveLength(3);
    });

    it('excludes the current session', () => {
      // Record current session
      ctx.engine.recordSessionStart('claude-code', '1.0', 5, '1.3.0');

      const sessions = ctx.engine.getUnreportedSessions();
      expect(sessions).toHaveLength(0);
    });
  });

  describe('markSessionsReported', () => {
    it('sets reported=1 for given session IDs', () => {
      const db = new Database(dbPath());
      db.run(
        'INSERT INTO sessions (session_id, client, started_at, vault_size, version, reported) VALUES (?, ?, ?, ?, ?, ?)',
        'sess-a', 'claude-code', Date.now(), 10, '1.0.0', 0,
      );
      db.run(
        'INSERT INTO sessions (session_id, client, started_at, vault_size, version, reported) VALUES (?, ?, ?, ?, ?, ?)',
        'sess-b', 'cursor', Date.now(), 5, '1.0.0', 0,
      );
      db.close();

      ctx.engine.markSessionsReported(['sess-a', 'sess-b']);

      const db2 = getDb();
      const rows = db2.prepare('SELECT session_id, reported FROM sessions WHERE session_id IN (?, ?)').all('sess-a', 'sess-b') as Array<{ session_id: string; reported: number }>;
      db2.close();

      for (const row of rows) {
        expect(row.reported).toBe(1);
      }
    });

    it('does not error with empty array', () => {
      expect(() => ctx.engine.markSessionsReported([])).not.toThrow();
    });
  });
});
