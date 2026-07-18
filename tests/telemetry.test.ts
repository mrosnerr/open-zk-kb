import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { handleMaintain, handleSearch, handleHealth, handleStore } from '../src/tool-handlers.js';
import { cleanupTestHarness, createTestHarness, sleep, type TestContext } from './harness.js';

describe('local tool telemetry', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness({ telemetryEnabled: true });
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
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
    await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    await sleep(0);

    const rows = ctx.engine.getTelemetryRows();
    expect(rows.map(row => row.tool_name)).toEqual(['store', 'search', 'maintain']);
    expect(rows[0].arg_kind).toBe('observation');
    expect(rows[0].result_count).toBe(1);
    expect(rows[1].arg_kind).toBeNull();
    expect(rows[1].result_count).toBe(1);
    expect(rows[2].arg_kind).toBe('review');
    expect(rows[2].result_count).toBeNull();
    expect(new Set(rows.map(row => row.session_id)).size).toBe(1);
  });

  it('updates last_accessed_at only for returned search results', async () => {
    const alpha = ctx.engine.store('alpha returned content', { title: 'Returned', kind: 'reference' });
    const beta = ctx.engine.store('beta unrelated content', { title: 'Unrelated', kind: 'reference' });

    handleSearch({ query: 'alpha' }, ctx.engine, null, ctx.config);
    await sleep(0);

    const accessed = ctx.engine.getById(alpha.id);
    const unrelated = ctx.engine.getById(beta.id);
    expect(accessed?.last_accessed_at).toBeNumber();
    expect(accessed?.access_count).toBe(1);
    expect(unrelated?.last_accessed_at).toBeNull();
    expect(unrelated?.access_count).toBe(0);
  });

  it('disables telemetry rows and access tracking when opted out', () => {
    cleanupTestHarness(ctx);
    ctx = createTestHarness({ telemetryEnabled: false });
    const stored = ctx.engine.store('private alpha content', { title: 'Private Alpha', kind: 'reference' });

    handleSearch({ query: 'private alpha' }, ctx.engine, null, ctx.config);
    ctx.engine.recordToolInvocation('store', 'reference', 1);
    ctx.engine.updateLastAccessed([stored.id]);

    expect(ctx.engine.getTelemetryRows()).toEqual([]);
    const note = ctx.engine.getById(stored.id);
    expect(note?.last_accessed_at).toBeNull();
    expect(note?.access_count).toBe(0);
  });

  it('aggregates 30-day telemetry by session, stored kind, and maintain action', async () => {
    ctx.engine.recordToolInvocation('search', undefined, 3);
    await sleep(2);
    ctx.engine.recordToolInvocation('store', 'observation', 1);
    ctx.engine.recordToolInvocation('store', 'observation', 1);
    ctx.engine.recordToolInvocation('store', 'decision', 1);
    ctx.engine.recordToolInvocation('maintain', 'review');
    ctx.engine.recordToolInvocation('maintain', 'review');
    ctx.engine.recordToolInvocation('maintain', 'review');

    const aggregates = ctx.engine.getTelemetryAggregates(30);

    expect(aggregates.sessions).toBe(1);
    expect(aggregates.searches).toBe(1);
    expect(aggregates.stores).toBe(3);
    expect(aggregates.maintains).toBe(3);
    expect(aggregates.storesByKind).toEqual({ observation: 2, decision: 1 });
    expect(aggregates.maintainByAction).toEqual({ review: 3 });
    expect(aggregates.sessionDurations.length).toBe(1);
    expect(aggregates.sessionDurations[0]).toBeGreaterThanOrEqual(0);
  });

  it('returns sensible zero aggregates for empty telemetry', () => {
    expect(ctx.engine.getTelemetryAggregates(30)).toEqual({
      sessions: 0,
      searches: 0,
      stores: 0,
      maintains: 0,
      mines: 0,
      storesByKind: {},
      maintainByAction: {},
      sessionDurations: [],
    });
  });

  it('appends stats telemetry output with the expected shape', async () => {
    ctx.engine.recordToolInvocation('search', undefined, 2);
    await sleep(2);
    ctx.engine.recordToolInvocation('store', 'observation', 1);
    ctx.engine.recordToolInvocation('maintain', 'review');

    const output = await handleHealth({ telemetry: true }, ctx.engine, ctx.config);

    expect(output).toContain('Last 30 days (1 sessions):');
    expect(output).toContain('  Searches: 1 (avg 1 per session)');
    expect(output).toContain('  Stores: 1 (avg 1 per session)');
    expect(output).toContain('  Store / search ratio: 1.00');
    expect(output).toContain('  Most-stored kind: observation (1)');
    expect(output).toContain('  Most-used action: review (1)');
    expect(output).toContain('  Avg session duration:');
    expect(output).not.toContain('interpretation');
  });
});
