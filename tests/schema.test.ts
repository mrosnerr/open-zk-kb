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

  it('sets schema version 5 for a fresh database after initialize and repair', () => {
    const db = new Database(':memory:');
    const schema = new SchemaManager(db);

    schema.initialize();
    const result = schema.checkAndRepair();

    expect(result.valid).toBe(true);
    expect(result.needsRebuild).toBe(false);
    expect(getUserVersion(db)).toBe(5);
    db.close();
  });

  it('creates required tables notes, notes_fts, note_links, and capture_metrics', () => {
    const db = new Database(':memory:');
    const schema = new SchemaManager(db);

    schema.initialize();
    schema.checkAndRepair();

    expect(tableExists(db, 'notes')).toBe(true);
    expect(tableExists(db, 'notes_fts')).toBe(true);
    expect(tableExists(db, 'note_links')).toBe(true);
    expect(tableExists(db, 'capture_metrics')).toBe(true);
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
    expect(getUserVersion(db)).toBe(5);
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
    expect(getUserVersion(db)).toBe(5);
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
    expect(getUserVersion(db)).toBe(5);
    db.close();
  });

  it('migrates from v4 to v5: content_hash + capture_metrics', () => {
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
    db.run('PRAGMA user_version = 4');

    const schema = new SchemaManager(db);
    schema.checkAndRepair();

    const columns = getColumns(db, 'notes');
    expect(columns).toContain('content_hash');
    expect(tableExists(db, 'capture_metrics')).toBe(true);
    expect(getUserVersion(db)).toBe(5);
    db.close();
  });
});
