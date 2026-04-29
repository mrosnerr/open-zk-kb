import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NoteRepository } from '../src/storage/NoteRepository.js';
import { handleMaintain, handleSearch, handleStore } from '../src/tool-handlers.js';
import type { AppConfig } from '../src/types.js';
import { KIND_DEFAULT_LIFECYCLE } from '../src/types.js';

interface TelemetryRow {
  session_id: string;
  tool_name: string;
  arg_kind: string | null;
  timestamp: number;
  result_count: number | null;
}

class InspectableRepository extends NoteRepository {
  telemetryRows(): TelemetryRow[] {
    return this.db.prepare(`
      SELECT session_id, tool_name, arg_kind, timestamp, result_count
      FROM tool_telemetry
      ORDER BY id
    `).all() as TelemetryRow[];
  }

  setTelemetryTimestamp(index: number, timestamp: number): void {
    const rows = this.db.prepare('SELECT id FROM tool_telemetry ORDER BY id').all() as Array<{ id: number }>;
    const row = rows[index];
    if (row) this.db.prepare('UPDATE tool_telemetry SET timestamp = ? WHERE id = ?').run(timestamp, row.id);
  }

  insertTelemetry(sessionId: string, toolName: string, argKind: string | null, timestamp: number, resultCount: number | null): void {
    this.db.prepare(`
      INSERT INTO tool_telemetry (session_id, tool_name, arg_kind, timestamp, result_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, toolName, argKind, timestamp, resultCount);
  }
}

interface TelemetryContext {
  tempDir: string;
  engine: InspectableRepository;
  config: AppConfig;
}

function createTelemetryContext(telemetryEnabled: boolean = true): TelemetryContext {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-telemetry-test-'));
  const config: AppConfig = {
    logLevel: 'ERROR',
    vault: tempDir,
    lifecycle: {
      reviewAfterDays: 14,
      promotionThreshold: 2,
      exemptKinds: ['personalization', 'decision'],
      autoArchiveFleetingDays: 90,
    },
    lifecycleDefaults: {
      defaultForKind: { ...KIND_DEFAULT_LIFECYCLE },
      detectSnapshotFromSlug: true,
    },
    search: {
      alwaysIncludeDomainNote: true,
      excludeLogFromSearch: true,
    },
    navigation: {
      enableProjectIndex: false,
      enableProjectLog: false,
      enableGlobalIndex: false,
      enableGlobalLog: false,
      enableReviewMoc: false,
      mocSplitThreshold: 30,
      mocPreviewCount: 5,
      overviewLogEntryLimit: 10,
    },
    telemetry: {
      enabled: telemetryEnabled,
    },
  };
  return {
    tempDir,
    config,
    engine: new InspectableRepository(tempDir, { telemetryEnabled }),
  };
}

function cleanupTelemetryContext(ctx: TelemetryContext): void {
  ctx.engine.close();
  fs.rmSync(ctx.tempDir, { recursive: true, force: true });
}

describe('local tool telemetry', () => {
  let ctx: TelemetryContext;

  beforeEach(() => {
    ctx = createTelemetryContext();
  });

  afterEach(() => {
    cleanupTelemetryContext(ctx);
  });

  it('records counter rows with arg_kind and result_count for tool calls', async () => {
    await handleStore({
      title: 'Alpha Observation',
      content: 'alpha telemetry content',
      kind: 'observation',
      summary: 'Alpha telemetry note',
      guidance: 'Use as telemetry fixture',
    }, ctx.engine, null, ctx.config);
    handleSearch({ query: 'alpha' }, ctx.engine, null, ctx.config);
    await handleMaintain({ action: 'stats' }, ctx.engine, ctx.config);

    const rows = ctx.engine.telemetryRows();
    expect(rows.map(row => row.tool_name)).toEqual(['store', 'search', 'maintain']);
    expect(rows[0].arg_kind).toBe('observation');
    expect(rows[0].result_count).toBe(1);
    expect(rows[1].arg_kind).toBeNull();
    expect(rows[1].result_count).toBe(1);
    expect(rows[2].arg_kind).toBe('stats');
    expect(rows[2].result_count).toBeNull();
    expect(new Set(rows.map(row => row.session_id)).size).toBe(1);
  });

  it('updates last_accessed_at only for returned search results', () => {
    const alpha = ctx.engine.store('alpha returned content', { title: 'Returned', kind: 'reference' });
    const beta = ctx.engine.store('beta unrelated content', { title: 'Unrelated', kind: 'reference' });

    handleSearch({ query: 'alpha' }, ctx.engine, null, ctx.config);

    const accessed = ctx.engine.getById(alpha.id);
    const unrelated = ctx.engine.getById(beta.id);
    expect(accessed?.last_accessed_at).toBeNumber();
    expect(accessed?.access_count).toBe(1);
    expect(unrelated?.last_accessed_at).toBeNull();
    expect(unrelated?.access_count).toBe(0);
  });

  it('disables telemetry rows and access tracking when opted out', () => {
    cleanupTelemetryContext(ctx);
    ctx = createTelemetryContext(false);
    const stored = ctx.engine.store('private alpha content', { title: 'Private Alpha', kind: 'reference' });

    handleSearch({ query: 'private alpha' }, ctx.engine, null, ctx.config);
    ctx.engine.recordToolInvocation('store', 'reference', 1);
    ctx.engine.updateLastAccessed([stored.id]);

    expect(ctx.engine.telemetryRows()).toEqual([]);
    const note = ctx.engine.getById(stored.id);
    expect(note?.last_accessed_at).toBeNull();
    expect(note?.access_count).toBe(0);
  });

  it('aggregates 30-day telemetry by session and stored kind', () => {
    const now = Date.now();
    const old = now - (31 * 24 * 60 * 60 * 1000);
    ctx.engine.insertTelemetry('s1', 'search', null, now - 1000, 3);
    ctx.engine.insertTelemetry('s1', 'store', 'observation', now - 500, 1);
    ctx.engine.insertTelemetry('s2', 'store', 'observation', now - 400, 1);
    ctx.engine.insertTelemetry('s2', 'store', 'decision', now - 300, 1);
    ctx.engine.insertTelemetry('s2', 'maintain', 'stats', now - 200, null);
    ctx.engine.insertTelemetry('old', 'search', null, old, 2);
    ctx.engine.insertTelemetry('old', 'store', 'resource', old, 1);

    const aggregates = ctx.engine.getTelemetryAggregates(30);

    expect(aggregates.sessions).toBe(2);
    expect(aggregates.searches).toBe(1);
    expect(aggregates.stores).toBe(3);
    expect(aggregates.maintains).toBe(1);
    expect(aggregates.storesByKind).toEqual({ observation: 2, decision: 1 });
    expect(aggregates.sessionDurations.length).toBe(2);
  });

  it('returns sensible zero aggregates for empty telemetry', () => {
    expect(ctx.engine.getTelemetryAggregates(30)).toEqual({
      sessions: 0,
      searches: 0,
      stores: 0,
      maintains: 0,
      storesByKind: {},
      sessionDurations: [],
    });
  });

  it('appends stats telemetry output with the expected shape', async () => {
    ctx.engine.insertTelemetry('s1', 'search', null, Date.now() - 1000, 2);
    ctx.engine.insertTelemetry('s1', 'store', 'observation', Date.now() - 500, 1);

    const output = await handleMaintain({ action: 'stats', telemetry: true }, ctx.engine, ctx.config);

    expect(output).toContain('Last 30 days (2 sessions):');
    expect(output).toContain('  Searches: 1 (avg 0.5 per session)');
    expect(output).toContain('  Stores: 1 (avg 0.5 per session)');
    expect(output).toContain('  Store / search ratio: 1.00');
    expect(output).toContain('  Most-stored kind: observation (1)');
    expect(output).toContain('  Search-to-store ratio interpretation:');
    expect(output).toContain('    High capture (≥ 0.30): suggestions probably unnecessary');
    expect(output).toContain('    Low capture (< 0.30):  detection-as-suggestion would help');
  });
});
