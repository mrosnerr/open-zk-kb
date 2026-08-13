import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  handleContext,
  handleGet,
  handleHealth,
  handleIngest,
  handleMaintain,
  handleMine,
  handleOpen,
  handleSearch,
  handleStore,
  handleTemplate,
  type IngestArgs,
  type MaintainArgs,
} from '../src/tool-handlers.js';
import { NoteRepository, TELEMETRY_TOOL_NAMES, normalizeTelemetryModel } from '../src/storage/NoteRepository.js';
import { TOOL_DEFINITIONS } from '../src/tool-meta.js';
import { cleanupTestHarness, createTestHarness, sleep, type TestContext } from './harness.js';

describe('local tool telemetry', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness({ telemetryEnabled: true });
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
  });

  it('derives the canonical telemetry taxonomy one-to-one from tool metadata', () => {
    expect(TELEMETRY_TOOL_NAMES).toEqual(TOOL_DEFINITIONS.map(tool => tool.name.replace('knowledge-', '')));
    expect(new Set(TELEMETRY_TOOL_NAMES).size).toBe(10);
  });

  it('normalizes session clients and bounds versions before durable persistence', () => {
    ctx.engine.recordSessionStart('open-zk-kb-pi', '1.2.3', 0, 'test', true);
    ctx.engine.recordSessionEnd();
    const observer = new NoteRepository(ctx.tempDir, { telemetryEnabled: true });
    const session = observer.getUnreportedSessions()[0];
    expect(session.client).toBe('pi');
    expect(session.client_version).toBe('1.2.3');
    observer.close();

    cleanupTestHarness(ctx);
    ctx = createTestHarness({ telemetryEnabled: true });
    ctx.engine.recordSessionStart('private malformed client', 'identifying arbitrary version', 0, 'test', true);
    ctx.engine.recordSessionEnd();
    const unknownObserver = new NoteRepository(ctx.tempDir, { telemetryEnabled: true });
    const unknown = unknownObserver.getUnreportedSessions()[0];
    expect(unknown.client).toBe('other');
    expect(unknown.client_version).toBeNull();
    unknownObserver.close();
  });

  it('buckets model families without retaining provider, deployment, or model suffixes', () => {
    expect(normalizeTelemetryModel('private-customer/claude-sonnet-4')).toBe('claude');
    expect(normalizeTelemetryModel('anthropic/claude-sonnet-4')).toBe('claude');
    expect(normalizeTelemetryModel('openai/gpt-5')).toBe('gpt');
    expect(normalizeTelemetryModel('openai/chatgpt-4o-latest')).toBe('gpt');
    expect(normalizeTelemetryModel('openai/o3-mini')).toBe('openai-o');
    expect(normalizeTelemetryModel('google/gemini-2.5-pro')).toBe('gemini');
    expect(normalizeTelemetryModel('moonshot/kimi-k2')).toBe('kimi');
    expect(normalizeTelemetryModel('minimax/minimax-m2')).toBe('minimax');
    expect(normalizeTelemetryModel('private-deployment-customer-42')).toBe('other');
    expect(normalizeTelemetryModel('private//claude-sonnet-4')).toBe('other');
    expect(normalizeTelemetryModel('unknown/model-1')).toBe('other');
  });

  it('records maintain only after success and counts full without recursive substeps', async () => {
    await handleMaintain({ action: 'promote' }, ctx.engine, ctx.config);
    await handleMaintain({ action: 'full', dryRun: true }, ctx.engine, ctx.config);
    await sleep(0);

    const maintainRows = ctx.engine.getTelemetryRows().filter(row => row.tool_name === 'maintain');
    expect(maintainRows.map(row => row.arg_kind)).toEqual(['full']);
  });

  it('records counter rows with arg_kind and result_count for tool calls', async () => {
    await handleStore({ project: 'test-project',
      title: 'Alpha Observation',
      content: 'alpha telemetry content',
      kind: 'observation',
      summary: 'Alpha telemetry note',
      guidance: 'Use as telemetry fixture',
    }, ctx.engine, null, ctx.config);
    handleSearch({ project: 'test-project', query: 'alpha' }, ctx.engine, null, ctx.config);
    await handleMaintain({ action: 'review' }, ctx.engine, ctx.config);
    await sleep(0);

    const rows = ctx.engine.getTelemetryRows();
    expect(rows.map(row => row.tool_name)).toEqual(['store', 'search', 'maintain']);
    expect(rows[0].arg_kind).toBe('observation:create');
    expect(rows[0].result_count).toBe(1);
    expect(rows[1].arg_kind).toBeNull();
    expect(rows[1].result_count).toBe(1);
    expect(rows[2].arg_kind).toBe('review');
    expect(rows[2].result_count).toBeNull();
    expect(new Set(rows.map(row => row.session_id)).size).toBe(1);
  });

  it('records content-free reviewed store outcomes without candidate identity', async () => {
    await handleStore({ project: 'test-project', title: 'Telemetry Review Target', content: 'telemetry collision content', kind: 'reference', summary: 'Telemetry collision summary.', guidance: 'Use telemetry target.' }, ctx.engine, null, ctx.config);
    await handleStore({ project: 'test-project', title: 'Telemetry Review Target', content: 'replacement collision content', kind: 'reference', summary: 'Replacement collision summary.', guidance: 'Use replacement target.', dryRun: true }, ctx.engine, null, ctx.config);
    await handleStore({ project: 'test-project', title: 'Skipped Telemetry Candidate', content: 'skipped telemetry content', kind: 'reference', summary: 'Skipped telemetry summary.', guidance: 'Skip telemetry candidate.', disposition: 'skip' }, ctx.engine, null, ctx.config);
    await sleep(0);

    const rows = ctx.engine.getTelemetryRows();
    expect(rows.map(row => row.arg_kind)).toEqual(['reference:create', 'reference:collision-review', 'reference:skip']);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('Telemetry Review Target');
    expect(serialized).not.toContain('replacement collision content');
  });

  it('updates last_accessed_at only for returned search results', async () => {
    const alpha = ctx.engine.store('alpha returned content', { title: 'Returned', kind: 'reference', tags: ['project:test-project'] });
    const beta = ctx.engine.store('beta unrelated content', { title: 'Unrelated', kind: 'reference', tags: ['project:test-project'] });

    handleSearch({ project: 'test-project', query: 'alpha' }, ctx.engine, null, ctx.config);
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
    const stored = ctx.engine.store('private alpha content', { title: 'Private Alpha', kind: 'reference', tags: ['project:test-project'] });

    handleSearch({ project: 'test-project', query: 'private alpha' }, ctx.engine, null, ctx.config);
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
      contextualLinkScans: { runs: 0, excludedCandidates: 0 },
    });
  });

  it('appends stats telemetry output with the expected shape', async () => {
    ctx.engine.recordToolInvocation('search', undefined, 2);
    await sleep(2);
    ctx.engine.recordToolInvocation('store', 'observation', 1);
    ctx.engine.recordToolInvocation('maintain', 'review');

    const output = await handleHealth({ project: 'test-project', telemetry: true }, ctx.engine, ctx.config);

    expect(output).toContain('Last 30 days (1 sessions):');
    expect(output).toContain('  Searches: 1 (avg 1 per session)');
    expect(output).toContain('  Stores: 1 (avg 1 per session)');
    expect(output).toContain('  Store / search ratio: 1.00');
    expect(output).toContain('  Most-stored kind: observation (1)');
    expect(output).toContain('  Most-used action: review (1)');
    expect(output).toContain('  Avg session duration:');
    expect(output).not.toContain('interpretation');
  });

  describe('all-ten canonical tool matrix', () => {
    const MODEL = 'claude-sonnet-4';
    const MODEL_BUCKET = 'claude';
    const MODEL_CAPABLE = TELEMETRY_TOOL_NAMES.filter(name => name !== 'open');

    it('records each canonical handler exactly once with models, session counts, and a sum-consistent total', async () => {
      ctx.engine.recordSessionStart('open-zk-kb-pi', '1.2.3', 0, 'test', true);

      const storeOutput = await handleStore({
        project: 'test-project',
        title: 'Telemetry Matrix Note',
        content: 'telemetry matrix content used by the ten tool accounting matrix',
        kind: 'observation',
        summary: 'Telemetry matrix fixture note.',
        guidance: 'Use as ten-tool telemetry matrix fixture.',
        model: MODEL,
      }, ctx.engine, null, ctx.config);
      expect(storeOutput).toContain('Stored observation');
      const storedId = /→ (\d{12,16})/.exec(storeOutput)?.[1];
      expect(storedId).toBeDefined();

      await handleIngest({
        html: `<html><body><article><h1>Matrix Ingest</h1><p>${'Ingestable telemetry article body text for the matrix fixture. '.repeat(6)}</p></article></body></html>`,
        model: MODEL,
      }, ctx.engine);

      handleSearch({ project: 'test-project', query: 'telemetry matrix', model: MODEL }, ctx.engine, null, ctx.config);
      handleContext({ project: 'test-project', model: MODEL }, ctx.engine, ctx.config);

      await handleOpen({
        project: 'test-project',
        _detectObsidian: () => ({ installed: true, binaryPath: '/mock/obsidian' }),
        _launchObsidian: () => null,
        _ensureScaffold: async () => null,
      }, ctx.config, ctx.engine);

      if (!storedId) throw new Error(`Store output did not include a note id: ${storeOutput}`);
      handleGet({ noteId: storedId, project: 'test-project', model: MODEL }, ctx.engine);
      await handleHealth({ project: 'test-project', model: MODEL }, ctx.engine, ctx.config);
      await handleMaintain({ action: 'review', model: MODEL }, ctx.engine, ctx.config);
      await handleMine({
        project: 'test-project',
        candidates: [{
          title: 'Mined Telemetry Candidate',
          content: 'mined telemetry candidate body content for dry run preview classification',
          kind: 'observation',
          summary: 'Mined telemetry candidate summary.',
          guidance: 'Use as mined telemetry candidate.',
        }],
        dry_run: true,
        model: MODEL,
      }, ctx.engine, null, ctx.config);
      handleTemplate({ kind: 'observation', project: 'test-project', model: MODEL }, ctx.engine);

      await sleep(0);

      const rows = ctx.engine.getTelemetryRows();
      expect(rows.map(row => row.tool_name).sort()).toEqual([...TELEMETRY_TOOL_NAMES].sort());
      expect(rows).toHaveLength(10);

      const byName = new Map(rows.map(row => [row.tool_name, row]));
      expect(rows.every(row => row.session_id === ctx.engine.getSessionId())).toBe(true);
      for (const toolName of MODEL_CAPABLE) {
        expect(byName.get(toolName)?.model, `model for ${toolName}`).toBe(MODEL_BUCKET);
      }
      expect(byName.get('open')?.model).toBeNull();

      ctx.engine.recordSessionEnd();
      // getUnreportedSessions excludes the caller's own live session, so read
      // the completed session through a second repository on the same vault.
      const observer = new NoteRepository(ctx.tempDir, { telemetryEnabled: true });
      const [session] = observer.getUnreportedSessions();
      observer.close();
      const expectedCounts = Object.fromEntries(TELEMETRY_TOOL_NAMES.map(name => [name, 1]));
      expect(session.tool_counts).toEqual(expectedCounts);
      expect(session.total_invocations).toBe(10);
      expect(session.total_invocations).toBe(Object.values(session.tool_counts).reduce((sum, count) => sum + count, 0));
      expect(session.models).toEqual([MODEL_BUCKET]);
    });
  });

  describe('negative and early-return accounting', () => {
    const MODEL_FOR_REJECT = 'claude-sonnet-4';

    it('records zero rows for schema/argument-style rejection and early error returns', async () => {
      handleSearch({ project: 'test-project', query: 'x', mode: 'compact', limit: 11 }, ctx.engine, null, ctx.config);
      await handleStore({
        project: 'test-project',
        title: 'Global Attempt',
        content: 'global storage attempt',
        kind: 'reference',
        summary: 'Rejected summary.',
        guidance: 'Rejected guidance.',
        tags: ['scope:global'],
      }, ctx.engine, null, ctx.config);
      handleGet({ noteId: '999999999999', project: '', model: MODEL_FOR_REJECT }, ctx.engine);
      handleContext({ project: '', model: MODEL_FOR_REJECT }, ctx.engine, ctx.config);
      await handleHealth({ project: '', model: MODEL_FOR_REJECT }, ctx.engine, ctx.config);
      await sleep(0);

      expect(ctx.engine.getTelemetryRows()).toEqual([]);
    });

    it('records zero rows when a handler throws before completing', async () => {
      await expect(handleIngest({} as IngestArgs, ctx.engine)).rejects.toThrow('Either url or html must be provided');
      await sleep(0);
      expect(ctx.engine.getTelemetryRows()).toEqual([]);
    });

    it('records zero rows for maintain invalid or missing action arguments', async () => {
      await handleMaintain({ action: 'not-a-real-action' } as MaintainArgs, ctx.engine, ctx.config);
      await handleMaintain({} as MaintainArgs, ctx.engine, ctx.config);
      await sleep(0);
      expect(ctx.engine.getTelemetryRows()).toEqual([]);
    });

    it('records zero rows when open fails to launch', async () => {
      const result = await handleOpen({
        project: 'test-project',
        _detectObsidian: () => ({ installed: true, binaryPath: '/mock/obsidian' }),
        _launchObsidian: () => 'Mock launch failure',
        _ensureScaffold: async () => null,
      }, ctx.config, ctx.engine);
      expect(result).toContain('Failed to launch Obsidian');
      await sleep(0);
      expect(ctx.engine.getTelemetryRows()).toEqual([]);
    });

    it('counts successful early-return paths exactly once', async () => {
      ctx.engine.store('unrelated content for search misses', { title: 'Unrelated', kind: 'reference', tags: ['project:test-project'] });

      const noResults = handleSearch({ project: 'test-project', query: 'zzz-no-match-zzz', model: MODEL_FOR_REJECT }, ctx.engine, null, ctx.config);
      expect(noResults).toContain('No matching notes found');

      const skipped = await handleStore({
        project: 'test-project',
        title: 'Skipped Telemetry',
        content: 'skipped telemetry content',
        kind: 'reference',
        summary: 'Skipped summary.',
        guidance: 'Skipped guidance.',
        disposition: 'skip',
      }, ctx.engine, null, ctx.config);
      expect(skipped).toContain('skipped');
      await sleep(0);

      const rows = ctx.engine.getTelemetryRows();
      expect(rows.map(row => row.tool_name).sort()).toEqual(['search', 'store']);
      expect(rows.filter(row => row.tool_name === 'search')).toHaveLength(1);
      expect(rows.filter(row => row.tool_name === 'store')).toHaveLength(1);
    });
  });

  describe('deprecated alias routing', () => {
    it('routes shared overview/context and stats/health paths to canonical counters only', async () => {
      // mcp-server registers knowledge-overview with the same handler as
      // knowledge-context, and knowledge-stats with the same handler as
      // knowledge-health (verified in tests/mcp-protocol.test.ts). Those
      // shared handlers are exactly the functions invoked below, so an alias
      // call can only increment the canonical counter.
      handleContext({ project: 'test-project', model: 'claude-sonnet-4' }, ctx.engine, ctx.config);
      await handleHealth({ project: 'test-project', model: 'claude-sonnet-4' }, ctx.engine, ctx.config);
      await sleep(0);

      const rows = ctx.engine.getTelemetryRows();
      const names = rows.map(row => row.tool_name).sort();
      expect(names).toEqual(['context', 'health']);
      expect(names).not.toContain('overview');
      expect(names).not.toContain('stats');

      // The canonical taxonomy has no alias-specific counters.
      expect(TELEMETRY_TOOL_NAMES).not.toContain('overview');
      expect(TELEMETRY_TOOL_NAMES).not.toContain('stats');
      expect([...TELEMETRY_TOOL_NAMES].sort()).toEqual([
        'context', 'get', 'health', 'ingest', 'maintain', 'mine', 'open', 'search', 'store', 'template',
      ]);
    });
  });
});
