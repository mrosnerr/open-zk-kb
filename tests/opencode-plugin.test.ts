import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTestHarness, cleanupTestHarness, type TestContext } from './harness';
import { detectProject } from '../src/opencode-plugin/project-detect';
import { fetchKbContext, formatContext } from '../src/opencode-plugin/context';
import { createKbPlugin } from '../src/opencode-plugin/plugin';
import { NoteRepository } from '../src/storage/NoteRepository';

// ── project-detect ──

describe('detectProject', () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it('extracts top-level directory under ~/dev/', () => {
    process.env.HOME = '/Users/teal';
    expect(detectProject('/Users/teal/dev/open-zk-kb')).toBe('open-zk-kb');
  });

  it('extracts top-level even for nested paths', () => {
    process.env.HOME = '/Users/teal';
    expect(detectProject('/Users/teal/dev/open-zk-kb/src/storage')).toBe('open-zk-kb');
  });

  it('falls back to basename outside ~/dev/', () => {
    process.env.HOME = '/Users/teal';
    expect(detectProject('/tmp/my-project')).toBe('my-project');
  });

  it('returns null for home directory', () => {
    process.env.HOME = '/Users/teal';
    expect(detectProject('/Users/teal')).toBeNull();
  });

  it('returns null for root', () => {
    expect(detectProject('/')).toBeNull();
  });
});

// ── read-only NoteRepository ──

describe('NoteRepository readonly mode', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
  });

  it('opens existing DB in readonly mode', () => {
    const readonlyRepo = new NoteRepository(ctx.tempDir, { readonly: true });
    expect(readonlyRepo).toBeDefined();
    readonlyRepo.close();
  });

  it('search works on readonly connection', () => {
    ctx.engine.store('Test note content', {
      title: 'Test Note',
      kind: 'reference',
      status: 'permanent',
      tags: ['project:myapp'],
      summary: 'A test note',
      guidance: 'Use for testing',
    });

    const readonlyRepo = new NoteRepository(ctx.tempDir, { readonly: true });
    const results = readonlyRepo.search('test', { tags: ['project:myapp'] });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Test Note');
    readonlyRepo.close();
  });

  it('getDomainNote works on readonly connection', () => {
    ctx.engine.store('Domain content for myapp', {
      title: 'myapp domain',
      kind: 'domain',
      status: 'permanent',
      tags: ['project:myapp'],
      summary: 'Domain note for myapp',
      guidance: 'Follow these conventions',
    });

    const readonlyRepo = new NoteRepository(ctx.tempDir, { readonly: true });
    const domain = readonlyRepo.getDomainNote('myapp');
    expect(domain).not.toBeNull();
    expect(domain!.kind).toBe('domain');
    readonlyRepo.close();
  });

  it('throws when DB does not exist', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-empty-'));
    try {
      expect(() => new NoteRepository(emptyDir, { readonly: true }))
        .toThrow('Database not found');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ── context fetching ──

describe('fetchKbContext', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
  });

  it('returns domain note and relevant permanent notes', () => {
    ctx.engine.store('Domain: conventions for myapp', {
      title: 'myapp domain',
      kind: 'domain',
      status: 'permanent',
      tags: ['project:myapp'],
      summary: 'Project conventions',
      guidance: 'Follow these rules',
    });

    ctx.engine.store('We chose FTS5 for search', {
      title: 'FTS5 search decision',
      kind: 'decision',
      status: 'permanent',
      tags: ['project:myapp'],
      summary: 'Chose FTS5 over trigram',
      guidance: 'Use FTS5 for all search',
    });

    const result = fetchKbContext(ctx.engine, 'myapp');
    expect(result.project).toBe('myapp');
    expect(result.domainNote).not.toBeNull();
    expect(result.domainNote!.kind).toBe('domain');
    expect(result.recentNotes.length).toBeGreaterThan(0);
  });

  it('excludes domain note from recent results', () => {
    ctx.engine.store('Domain content', {
      title: 'myapp domain',
      kind: 'domain',
      status: 'permanent',
      tags: ['project:myapp'],
      summary: 'Domain note',
      guidance: 'Guidance',
    });

    const result = fetchKbContext(ctx.engine, 'myapp');
    const recentIds = result.recentNotes.map(n => n.id);
    if (result.domainNote) {
      expect(recentIds).not.toContain(result.domainNote.id);
    }
  });

  it('excludes index and log kinds', () => {
    ctx.engine.store('Some decision', {
      title: 'Decision A',
      kind: 'decision',
      status: 'permanent',
      tags: ['project:myapp'],
      summary: 'Decision',
      guidance: 'Follow',
    });

    const result = fetchKbContext(ctx.engine, 'myapp');
    for (const note of result.recentNotes) {
      expect(note.kind).not.toBe('index');
      expect(note.kind).not.toBe('log');
    }
  });

  it('returns empty for project with no notes', () => {
    const result = fetchKbContext(ctx.engine, 'nonexistent');
    expect(result.domainNote).toBeNull();
    expect(result.recentNotes).toHaveLength(0);
  });
});

// ── formatContext ──

describe('formatContext', () => {
  it('returns empty string when no notes', () => {
    const result = formatContext({ domainNote: null, recentNotes: [], project: 'test' });
    expect(result).toBe('');
  });

  it('includes domain note XML', () => {
    const result = formatContext({
      project: 'myapp',
      domainNote: {
        id: '2026043000000000',
        title: 'myapp domain',
        kind: 'domain',
        status: 'permanent',
        lifecycle: 'living',
        type: 'atomic',
        tags: ['project:myapp'],
        content: '',
        summary: 'Project rules',
        guidance: 'Follow these',
        path: '/tmp/test.md',
        updated_at: Date.now(),
        created_at: Date.now(),
        word_count: 10,
      },
      recentNotes: [],
    });
    expect(result).toContain('## Knowledge Base Context (project: myapp)');
    expect(result).toContain('### Domain Note');
    expect(result).toContain('<note');
    expect(result).toContain('kind="domain"');
  });

  it('includes injection banner with note counts and kinds', () => {
    const result = formatContext({
      project: 'myapp',
      domainNote: {
        id: '2026043000000001',
        title: 'myapp domain',
        kind: 'domain',
        status: 'permanent',
        lifecycle: 'living',
        type: 'atomic',
        tags: ['project:myapp'],
        content: '',
        summary: 'Project rules',
        guidance: 'Follow these',
        path: '/tmp/test.md',
        updated_at: Date.now(),
        created_at: Date.now(),
        word_count: 10,
      },
      recentNotes: [
        {
          id: '2026043000000002',
          title: 'Auth decision',
          kind: 'decision',
          status: 'permanent',
          lifecycle: 'living',
          type: 'atomic',
          tags: ['project:myapp'],
          content: '',
          summary: 'Use JWT',
          guidance: 'Follow this',
          path: '/tmp/test.md',
          updated_at: Date.now(),
          created_at: Date.now(),
          word_count: 5,
        },
        {
          id: '2026043000000003',
          title: 'Style preference',
          kind: 'personalization',
          status: 'permanent',
          lifecycle: 'living',
          type: 'atomic',
          tags: ['project:myapp'],
          content: '',
          summary: 'Prefer arrow functions',
          guidance: 'Follow this',
          path: '/tmp/test.md',
          updated_at: Date.now(),
          created_at: Date.now(),
          word_count: 5,
        },
      ],
    });
    expect(result).toContain('> **Knowledge Base**: 3 notes injected');
    expect(result).toContain('> - [domain] myapp domain');
    expect(result).toContain('> - [decision] Auth decision');
    expect(result).toContain('> - [personalization] Style preference');
  });

  it('omits injection banner when no notes are present', () => {
    const result = formatContext({ domainNote: null, recentNotes: [], project: 'test' });
    expect(result).toBe('');
  });
});

// ── plugin lifecycle (3-hook integration) ──

describe('createKbPlugin lifecycle', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });

  afterEach(() => {
    delete process.env.__OPEN_ZK_KB_TEST_VAULT;
    cleanupTestHarness(ctx);
  });

  it('returns noop hooks when no project detected', async () => {
    const factory = createKbPlugin();
    const mockCtx = {
      directory: '/',
      client: { app: { log: () => {} } },
    };
    const hooks = await factory(mockCtx);

    const output = { system: [] as string[] };
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'ses_1', model: { id: 'test', providerID: 'test' } },
      output,
    );
    expect(output.system).toHaveLength(0);
  });

  it('injects context on first LLM turn after session.created', async () => {
    ctx.engine.store('Domain rules for testproject', {
      title: 'testproject domain',
      kind: 'domain',
      status: 'permanent',
      tags: ['project:testproject'],
      summary: 'Test project domain',
      guidance: 'Follow these rules',
    });
    ctx.engine.close();

    const factory = createKbPlugin();
    const mockCtx = {
      directory: `${process.env.HOME}/dev/testproject`,
      client: { app: { log: () => {} } },
    };

    process.env.__OPEN_ZK_KB_TEST_VAULT = ctx.tempDir;
    const hooks = await factory(mockCtx);

    await hooks.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'ses_test' } },
      },
    });

    const output = { system: [] as string[] };
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'ses_test', model: { id: 'test', providerID: 'test' } },
      output,
    );

    expect(output.system.length).toBeGreaterThan(0);
    expect(output.system[0]).toContain('Knowledge Base Context');
    expect(output.system[0]).toContain('Domain Note');
  });

  it('only injects once per session (consume marker)', async () => {
    ctx.engine.store('Domain content', {
      title: 'testproject domain',
      kind: 'domain',
      status: 'permanent',
      tags: ['project:testproject'],
      summary: 'Domain note',
      guidance: 'Rules',
    });
    ctx.engine.close();

    const factory = createKbPlugin();
    const mockCtx = {
      directory: `${process.env.HOME}/dev/testproject`,
      client: { app: { log: () => {} } },
    };

    process.env.__OPEN_ZK_KB_TEST_VAULT = ctx.tempDir;
    const hooks = await factory(mockCtx);

    await hooks.event({
      event: { type: 'session.created', properties: { info: { id: 'ses_once' } } },
    });

    const output1 = { system: [] as string[] };
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'ses_once', model: { id: 'test', providerID: 'test' } },
      output1,
    );
    expect(output1.system.length).toBeGreaterThan(0);

    const output2 = { system: [] as string[] };
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'ses_once', model: { id: 'test', providerID: 'test' } },
      output2,
    );
    expect(output2.system).toHaveLength(0);
  });

  it('re-injects on compaction and resets marker', async () => {
    ctx.engine.store('Domain content', {
      title: 'testproject domain',
      kind: 'domain',
      status: 'permanent',
      tags: ['project:testproject'],
      summary: 'Domain note',
      guidance: 'Rules',
    });
    ctx.engine.close();

    const factory = createKbPlugin();
    const mockCtx = {
      directory: `${process.env.HOME}/dev/testproject`,
      client: { app: { log: () => {} } },
    };

    process.env.__OPEN_ZK_KB_TEST_VAULT = ctx.tempDir;
    const hooks = await factory(mockCtx);

    await hooks.event({
      event: { type: 'session.created', properties: { info: { id: 'ses_compact' } } },
    });

    const output1 = { system: [] as string[] };
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'ses_compact', model: { id: 'test', providerID: 'test' } },
      output1,
    );
    expect(output1.system.length).toBeGreaterThan(0);

    const compactOutput = { context: [] as string[] };
    await hooks['experimental.session.compacting'](
      { sessionID: 'ses_compact' },
      compactOutput,
    );
    expect(compactOutput.context.length).toBeGreaterThan(0);
    expect(compactOutput.context[0]).toContain('Knowledge Base Context');

    const output2 = { system: [] as string[] };
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'ses_compact', model: { id: 'test', providerID: 'test' } },
      output2,
    );
    expect(output2.system.length).toBeGreaterThan(0);
  });

  it('cleans up state on session.deleted', async () => {
    ctx.engine.store('Domain content', {
      title: 'testproject domain',
      kind: 'domain',
      status: 'permanent',
      tags: ['project:testproject'],
      summary: 'Domain note',
      guidance: 'Rules',
    });
    ctx.engine.close();

    const factory = createKbPlugin();
    const mockCtx = {
      directory: `${process.env.HOME}/dev/testproject`,
      client: { app: { log: () => {} } },
    };

    process.env.__OPEN_ZK_KB_TEST_VAULT = ctx.tempDir;
    const hooks = await factory(mockCtx);

    await hooks.event({
      event: { type: 'session.created', properties: { info: { id: 'ses_del' } } },
    });

    await hooks.event({
      event: { type: 'session.deleted', properties: { info: { id: 'ses_del' } } },
    });

    const output = { system: [] as string[] };
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'ses_del', model: { id: 'test', providerID: 'test' } },
      output,
    );
    expect(output.system).toHaveLength(0);
  });
});
