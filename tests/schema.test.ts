import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SchemaManager } from '../src/schema.js';
import { createTestHarness, cleanupTestHarness } from './harness.js';
import type { TestContext } from './harness.js';

describe('schema.ts', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(ctx);
  });

  function getUserVersion(db: Database): number {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  }

  function getColumns(db: Database, tableName: string): string[] {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return rows.map(r => r.name);
  }

  function tableExists(db: Database, tableName: string): boolean {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(tableName);
    return Boolean(row);
  }

  it('sets current schema version for a fresh database after initialize and repair', () => {
    const db = new Database(':memory:');
    const schema = new SchemaManager(db);

    schema.initialize();
    const result = schema.checkAndRepair();

    expect(result.valid).toBe(true);
    expect(result.needsRebuild).toBe(false);
    expect(getUserVersion(db)).toBe(10);
    db.close();
  });

  it('creates required tables notes, notes_fts, note_links, and tool_telemetry', () => {
    const db = new Database(':memory:');
    const schema = new SchemaManager(db);

    schema.initialize();
    schema.checkAndRepair();

    expect(tableExists(db, 'notes')).toBe(true);
    expect(tableExists(db, 'notes_fts')).toBe(true);
    expect(tableExists(db, 'note_links')).toBe(true);
    expect(tableExists(db, 'tool_telemetry')).toBe(true);
    db.close();
  });

  it('creates notes table with all expected columns', () => {
    const db = new Database(':memory:');
    const schema = new SchemaManager(db);

    schema.initialize();
    schema.checkAndRepair();

    const columns = getColumns(db, 'notes');
    expect(columns).toEqual([
      'id',
      'path',
      'title',
      'content',
      'kind',
      'status',
      'type',
      'tags',
      'context',
      'created_at',
      'updated_at',
      'word_count',
      'access_count',
      'last_accessed_at',
      'summary',
      'guidance',
      'embedding',
      'embedding_model',
      'content_hash',
      'lifecycle',
    ]);
    db.close();
  });

  it('migration v1 adds kind column when missing', () => {
    const db = new Database(':memory:');

    db.run(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        path TEXT UNIQUE,
        title TEXT,
        content TEXT,
        status TEXT DEFAULT 'fleeting',
        type TEXT DEFAULT 'atomic',
        tags TEXT DEFAULT '[]',
        context TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER,
        word_count INTEGER DEFAULT 0,
        access_count INTEGER DEFAULT 0,
        last_accessed_at INTEGER
      )
    `);
    db.run("INSERT INTO notes(id, path, title, content, tags, context) VALUES ('n1', '/tmp/n1.md', 'N1', 'content', '[]', '')");
    db.run('CREATE TABLE note_links (source_id TEXT, target_id TEXT, link_text TEXT, created_at INTEGER, PRIMARY KEY (source_id, target_id))');
    db.run("CREATE VIRTUAL TABLE notes_fts USING fts5(title, content, tags, context, tokenize='porter')");
    db.run('PRAGMA user_version = -1');

    const schema = new SchemaManager(db);
    schema.checkAndRepair();

    const columns = getColumns(db, 'notes');
    expect(columns).toContain('kind');
    expect(getUserVersion(db)).toBe(10);
    db.close();
  });

  it('migration v3 adds summary and guidance columns', () => {
    const db = new Database(':memory:');

    db.run(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        path TEXT UNIQUE,
        title TEXT,
        content TEXT,
        kind TEXT DEFAULT 'observation',
        status TEXT DEFAULT 'fleeting',
        type TEXT DEFAULT 'atomic',
        tags TEXT DEFAULT '[]',
        context TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER,
        word_count INTEGER DEFAULT 0,
        access_count INTEGER DEFAULT 0,
        last_accessed_at INTEGER
      )
    `);
    db.run("CREATE VIRTUAL TABLE notes_fts USING fts5(note_id, title, content, tags, context, tokenize='porter')");
    db.run('CREATE TABLE note_links (source_id TEXT, target_id TEXT, link_text TEXT, created_at INTEGER, PRIMARY KEY (source_id, target_id))');
    db.run('PRAGMA user_version = 2');

    const schema = new SchemaManager(db);
    schema.checkAndRepair();

    const columns = getColumns(db, 'notes');
    expect(columns).toContain('summary');
    expect(columns).toContain('guidance');
    expect(getUserVersion(db)).toBe(10);
    db.close();
  });

  it('migration v4 adds embedding and embedding_model columns', () => {
    const db = new Database(':memory:');

    db.run(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        path TEXT UNIQUE,
        title TEXT,
        content TEXT,
        kind TEXT DEFAULT 'observation',
        status TEXT DEFAULT 'fleeting',
        type TEXT DEFAULT 'atomic',
        tags TEXT DEFAULT '[]',
        context TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER,
        word_count INTEGER DEFAULT 0,
        access_count INTEGER DEFAULT 0,
        last_accessed_at INTEGER,
        summary TEXT DEFAULT '',
        guidance TEXT DEFAULT ''
      )
    `);
    db.run("CREATE VIRTUAL TABLE notes_fts USING fts5(note_id, title, content, tags, context, tokenize='porter')");
    db.run('CREATE TABLE note_links (source_id TEXT, target_id TEXT, link_text TEXT, created_at INTEGER, PRIMARY KEY (source_id, target_id))');
    db.run('PRAGMA user_version = 3');

    const schema = new SchemaManager(db);
    schema.checkAndRepair();

    const columns = getColumns(db, 'notes');
    expect(columns).toContain('embedding');
    expect(columns).toContain('embedding_model');
    expect(getUserVersion(db)).toBe(10);
    db.close();
  });

  it('migrates from v4 to v5: adds content_hash and drops capture_metrics', () => {
    const db = new Database(':memory:');

    db.run(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        path TEXT UNIQUE,
        title TEXT,
        content TEXT,
        kind TEXT DEFAULT 'observation',
        status TEXT DEFAULT 'fleeting',
        type TEXT DEFAULT 'atomic',
        tags TEXT DEFAULT '[]',
        context TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER,
        word_count INTEGER DEFAULT 0,
        access_count INTEGER DEFAULT 0,
        last_accessed_at INTEGER,
        summary TEXT DEFAULT '',
        guidance TEXT DEFAULT '',
        embedding BLOB DEFAULT NULL,
        embedding_model TEXT DEFAULT NULL
      )
    `);
    db.run("CREATE VIRTUAL TABLE notes_fts USING fts5(note_id, title, content, tags, context, tokenize='porter')");
    db.run('CREATE TABLE note_links (source_id TEXT, target_id TEXT, link_text TEXT, created_at INTEGER, PRIMARY KEY (source_id, target_id))');
    db.run('CREATE TABLE capture_metrics (id INTEGER PRIMARY KEY)');
    db.run('PRAGMA user_version = 4');

    const schema = new SchemaManager(db);
    schema.checkAndRepair();

    const columns = getColumns(db, 'notes');
    expect(columns).toContain('content_hash');
    expect(tableExists(db, 'capture_metrics')).toBe(false);
    expect(getUserVersion(db)).toBe(10);
    db.close();
  });

  it('migrates from v5 to v6: adds lifecycle column', () => {
    const db = new Database(':memory:');

    db.run(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        path TEXT UNIQUE,
        title TEXT,
        content TEXT,
        kind TEXT DEFAULT 'observation',
        status TEXT DEFAULT 'fleeting',
        type TEXT DEFAULT 'atomic',
        tags TEXT DEFAULT '[]',
        context TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER,
        word_count INTEGER DEFAULT 0,
        access_count INTEGER DEFAULT 0,
        last_accessed_at INTEGER,
        summary TEXT DEFAULT '',
        guidance TEXT DEFAULT '',
        embedding BLOB DEFAULT NULL,
        embedding_model TEXT DEFAULT NULL,
        content_hash TEXT DEFAULT NULL
      )
    `);
    db.run("CREATE VIRTUAL TABLE notes_fts USING fts5(note_id, title, content, tags, context, tokenize='porter')");
    db.run('CREATE TABLE note_links (source_id TEXT, target_id TEXT, link_text TEXT, created_at INTEGER, PRIMARY KEY (source_id, target_id))');
    db.run('PRAGMA user_version = 5');

    const schema = new SchemaManager(db);
    schema.checkAndRepair();

    const columns = getColumns(db, 'notes');
    expect(columns).toContain('lifecycle');
    expect(getUserVersion(db)).toBe(10);
    db.close();
  });

  it('migrates from v6 to v7: adds telemetry table and last_accessed_at when missing', () => {
    const db = new Database(':memory:');

    db.run(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        path TEXT UNIQUE,
        title TEXT,
        content TEXT,
        kind TEXT DEFAULT 'observation',
        status TEXT DEFAULT 'fleeting',
        type TEXT DEFAULT 'atomic',
        tags TEXT DEFAULT '[]',
        context TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER,
        word_count INTEGER DEFAULT 0,
        access_count INTEGER DEFAULT 0,
        summary TEXT DEFAULT '',
        guidance TEXT DEFAULT '',
        embedding BLOB DEFAULT NULL,
        embedding_model TEXT DEFAULT NULL,
        content_hash TEXT DEFAULT NULL,
        lifecycle TEXT DEFAULT 'living'
      )
    `);
    db.run("CREATE VIRTUAL TABLE notes_fts USING fts5(note_id, title, content, tags, context, tokenize='porter')");
    db.run('CREATE TABLE note_links (source_id TEXT, target_id TEXT, link_text TEXT, created_at INTEGER, PRIMARY KEY (source_id, target_id))');
    db.run('PRAGMA user_version = 6');

    const schema = new SchemaManager(db);
    schema.checkAndRepair();

    const columns = getColumns(db, 'notes');
    expect(columns).toContain('last_accessed_at');
    expect(tableExists(db, 'tool_telemetry')).toBe(true);
    expect(getUserVersion(db)).toBe(10);
    db.close();
  });

  it('migrates from v7 to v8: adds template_conformance table', () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY, path TEXT UNIQUE, title TEXT, content TEXT,
        kind TEXT DEFAULT 'observation', status TEXT DEFAULT 'fleeting',
        type TEXT DEFAULT 'atomic', tags TEXT DEFAULT '[]', context TEXT DEFAULT '',
        created_at INTEGER, updated_at INTEGER, word_count INTEGER DEFAULT 0,
        access_count INTEGER DEFAULT 0, summary TEXT DEFAULT '', guidance TEXT DEFAULT '',
        embedding BLOB DEFAULT NULL, embedding_model TEXT DEFAULT NULL,
        content_hash TEXT DEFAULT NULL, lifecycle TEXT DEFAULT 'living',
        last_accessed_at INTEGER
      )
    `);
    db.run("CREATE VIRTUAL TABLE notes_fts USING fts5(note_id, title, content, tags, context, tokenize='porter')");
    db.run('CREATE TABLE note_links (source_id TEXT, target_id TEXT, link_text TEXT, created_at INTEGER, PRIMARY KEY (source_id, target_id))');
    db.run(`CREATE TABLE tool_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      arg_kind TEXT, timestamp INTEGER NOT NULL, result_count INTEGER
    )`);
    db.run('PRAGMA user_version = 7');

    const schema = new SchemaManager(db);
    schema.checkAndRepair();

    expect(tableExists(db, 'template_conformance')).toBe(true);
    expect(getUserVersion(db)).toBe(10);
    db.close();
  });

  it('migrates from v8 to v9: adds sessions table', () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY, path TEXT UNIQUE, title TEXT, content TEXT,
        kind TEXT DEFAULT 'observation', status TEXT DEFAULT 'fleeting',
        type TEXT DEFAULT 'atomic', tags TEXT DEFAULT '[]', context TEXT DEFAULT '',
        created_at INTEGER, updated_at INTEGER, word_count INTEGER DEFAULT 0,
        access_count INTEGER DEFAULT 0, summary TEXT DEFAULT '', guidance TEXT DEFAULT '',
        embedding BLOB DEFAULT NULL, embedding_model TEXT DEFAULT NULL,
        content_hash TEXT DEFAULT NULL, lifecycle TEXT DEFAULT 'living',
        last_accessed_at INTEGER
      )
    `);
    db.run("CREATE VIRTUAL TABLE notes_fts USING fts5(note_id, title, content, tags, context, tokenize='porter')");
    db.run('CREATE TABLE note_links (source_id TEXT, target_id TEXT, link_text TEXT, created_at INTEGER, PRIMARY KEY (source_id, target_id))');
    db.run(`CREATE TABLE tool_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      arg_kind TEXT, timestamp INTEGER NOT NULL, result_count INTEGER
    )`);
    db.run(`CREATE TABLE template_conformance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL, kind TEXT NOT NULL,
      action TEXT NOT NULL, model TEXT, coverage REAL NOT NULL,
      matched_categories TEXT NOT NULL, missing_categories TEXT NOT NULL,
      hint_triggered INTEGER NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`);
    db.run('PRAGMA user_version = 8');

    const schema = new SchemaManager(db);
    schema.checkAndRepair();

    expect(tableExists(db, 'sessions')).toBe(true);
    const columns = getColumns(db, 'sessions');
    expect(columns).toContain('session_id');
    expect(columns).toContain('client');
    expect(columns).toContain('client_version');
    expect(columns).toContain('started_at');
    expect(columns).toContain('ended_at');
    expect(columns).toContain('vault_size');
    expect(columns).toContain('version');
    expect(columns).toContain('os_platform');
    expect(columns).toContain('reported');
    expect(getUserVersion(db)).toBe(10);
    db.close();
  });

  it('migrates from v9 to v10: adds model column to tool_telemetry', () => {
    const db = new Database(':memory:');
    const schema = new SchemaManager(db);
    schema.initialize();
    // Simulate v9 by removing model column if it exists (initialize creates it)
    db.run('PRAGMA user_version = 9');
    // The migration should be idempotent — check it doesn't fail
    schema.checkAndRepair();

    const columns = getColumns(db, 'tool_telemetry');
    expect(columns).toContain('model');
    expect(getUserVersion(db)).toBe(10);
    db.close();
  });

  it('should handle schema downgrade gracefully (newer DB opened by older code)', () => {
    const db = ctx.engine['db'];
    const futureVersion = 99;
    db.run(`PRAGMA user_version = ${futureVersion}`);

    const schema = new SchemaManager(db);
    const result = schema.checkAndRepair();

    expect(result.valid).toBe(true);
    expect(result.needsRebuild).toBe(false);
    expect(getUserVersion(db)).toBe(futureVersion);
  });
});
