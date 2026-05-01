// schema.ts - Database schema management
// Provides CREATE TABLE IF NOT EXISTS with PRAGMA user_version migration support

import { Database } from 'bun:sqlite';
import { logToFile } from './logger.js';

export class SchemaManager {
  static readonly SCHEMA_VERSION = 8;

  private static readonly MIGRATIONS: Array<{
    version: number;
    description: string;
    migrate: (db: Database) => void;
  }> = [
    {
      version: 1,
      description: 'Add kind column, drop old FTS triggers',
      migrate: (db) => {
        const columns = db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'kind')) {
          db.run("ALTER TABLE notes ADD COLUMN kind TEXT DEFAULT 'observation'");
        }
        db.run('DROP TRIGGER IF EXISTS notes_fts_insert');
        db.run('DROP TRIGGER IF EXISTS notes_fts_delete');
        db.run('DROP TRIGGER IF EXISTS notes_fts_update');
      },
    },
    {
      version: 2,
      description: 'Rebuild FTS5 with note_id column',
      migrate: (db) => {
        const ftsSql = db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='notes_fts'"
        ).get() as { sql: string } | undefined;
        if (ftsSql && !ftsSql.sql.includes('note_id')) {
          db.run('DROP TABLE notes_fts');
          db.run(`CREATE VIRTUAL TABLE notes_fts USING fts5(
            note_id, title, content, tags, context, tokenize='porter'
          )`);
          // Repopulate from notes table
          const notes = db.prepare('SELECT id, title, content, tags, context FROM notes')
            .all() as Array<{ id: string; title: string; content: string; tags: string; context: string }>;
          const ins = db.prepare(
            'INSERT INTO notes_fts(note_id, title, content, tags, context) VALUES (?, ?, ?, ?, ?)'
          );
          for (const note of notes) {
            ins.run(note.id, note.title, note.content, note.tags, note.context);
          }
        }
      },
    },
    {
      version: 3,
      description: 'Add summary and guidance columns',
      migrate: (db) => {
        const columns = db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'summary')) {
          db.run("ALTER TABLE notes ADD COLUMN summary TEXT DEFAULT ''");
        }
        if (!columns.some(c => c.name === 'guidance')) {
          db.run("ALTER TABLE notes ADD COLUMN guidance TEXT DEFAULT ''");
        }
      },
    },
    {
      version: 4,
      description: 'Add embedding BLOB column for vector search',
      migrate: (db) => {
        const columns = db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'embedding')) {
          db.run('ALTER TABLE notes ADD COLUMN embedding BLOB DEFAULT NULL');
        }
        if (!columns.some(c => c.name === 'embedding_model')) {
          db.run("ALTER TABLE notes ADD COLUMN embedding_model TEXT DEFAULT NULL");
        }
      },
    },
    {
      version: 5,
      description: 'Add content_hash column',
      migrate: (db) => {
        const columns = db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'content_hash')) {
          db.run('ALTER TABLE notes ADD COLUMN content_hash TEXT DEFAULT NULL');
        }
        db.run('CREATE INDEX IF NOT EXISTS idx_notes_content_hash ON notes(content_hash)');
        db.run('DROP TABLE IF EXISTS capture_metrics');
      },
    },
    {
      version: 6,
      description: 'Add lifecycle column',
      migrate: (db) => {
        const columns = db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'lifecycle')) {
          db.run("ALTER TABLE notes ADD COLUMN lifecycle TEXT DEFAULT 'living'");
        }
      },
    },
    {
      version: 7,
      description: 'Add local tool telemetry and last access index',
      migrate: (db) => {
        const columns = db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'last_accessed_at')) {
          db.run('ALTER TABLE notes ADD COLUMN last_accessed_at INTEGER');
        }
        db.run('CREATE INDEX IF NOT EXISTS idx_notes_last_accessed_at ON notes(last_accessed_at)');
        SchemaManager.createTelemetryTable(db);
      },
    },
    {
      version: 8,
      description: 'Add template conformance tracking',
      migrate: (db) => {
        SchemaManager.createConformanceTable(db);
      },
    },
  ];

  private static createTelemetryTable(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS tool_telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arg_kind TEXT,
        timestamp INTEGER NOT NULL,
        result_count INTEGER
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON tool_telemetry(timestamp)');
    db.run('CREATE INDEX IF NOT EXISTS idx_telemetry_session ON tool_telemetry(session_id)');
  }

  private static createConformanceTable(db: Database): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS template_conformance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        model TEXT,
        coverage REAL NOT NULL,
        matched_categories TEXT NOT NULL,
        missing_categories TEXT NOT NULL,
        hint_triggered INTEGER NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_conformance_kind ON template_conformance(kind)');
    db.run('CREATE INDEX IF NOT EXISTS idx_conformance_timestamp ON template_conformance(timestamp)');
  }

  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  private getVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  }

  private setVersion(v: number): void {
    this.db.run(`PRAGMA user_version = ${v}`);
  }

  private runMigrations(): boolean {
    const current = this.getVersion();

    if (current === 0) {
      // Check if notes table has rows (legacy unversioned DB)
      const notesTable = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='notes'"
      ).get();

      if (notesTable) {
        const count = this.db.prepare('SELECT COUNT(*) as cnt FROM notes').get() as { cnt: number };
        if (count.cnt > 0) {
          logToFile('INFO', 'Legacy unversioned DB detected with data, dropping tables for rebuild');
          this.db.run('DROP TABLE IF EXISTS notes_fts');
          this.db.run('DROP TABLE IF EXISTS note_links');
          this.db.run('DROP TABLE IF EXISTS notes');
          this.initialize();
          this.setVersion(SchemaManager.SCHEMA_VERSION);
          return true; // signals needsRebuild
        }
      }

      // Fresh DB or empty notes table — just stamp the version
      this.setVersion(SchemaManager.SCHEMA_VERSION);
      return false;
    }

    if (current < SchemaManager.SCHEMA_VERSION) {
      for (const migration of SchemaManager.MIGRATIONS) {
        if (migration.version > current) {
          logToFile('INFO', `Running migration v${migration.version}: ${migration.description}`);
          migration.migrate(this.db);
          this.setVersion(migration.version);
        }
      }
      return false;
    }

    // Already at latest version
    return false;
  }

  initialize(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS notes (
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
        content_hash TEXT DEFAULT NULL,
        lifecycle TEXT DEFAULT 'living'
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_notes_content_hash ON notes(content_hash)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_notes_last_accessed_at ON notes(last_accessed_at)');
    SchemaManager.createTelemetryTable(this.db);
    SchemaManager.createConformanceTable(this.db);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS note_links (
        source_id TEXT,
        target_id TEXT,
        link_text TEXT,
        created_at INTEGER,
        PRIMARY KEY (source_id, target_id)
      )
    `);

    // FTS5 virtual table — standalone (not content-synced)
    // We manually manage inserts/updates/deletes in NoteRepository
    const ftsExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='notes_fts'"
    ).get();

    if (!ftsExists) {
      this.db.run(`
        CREATE VIRTUAL TABLE notes_fts USING fts5(
          note_id,
          title,
          content,
          tags,
          context,
          tokenize='porter'
        )
      `);
    }
  }

  checkAndRepair(): { valid: boolean; needsRebuild: boolean } {
    try {
      // Verify notes table exists
      const notesTable = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='notes'"
      ).get();
      if (!notesTable) {
        logToFile('WARN', 'Notes table missing, reinitializing schema');
        this.initialize();
      }

      // Verify FTS table exists
      const ftsTable = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='notes_fts'"
      ).get();
      if (!ftsTable) {
        logToFile('WARN', 'FTS table missing, reinitializing');
        this.initialize();
      }

      // Verify note_links table exists
      const linksTable = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='note_links'"
      ).get();
      if (!linksTable) {
        logToFile('WARN', 'note_links table missing, reinitializing');
        this.initialize();
      }

      // Run versioned migrations
      const needsRebuild = this.runMigrations();

      return { valid: true, needsRebuild };
    } catch (error) {
      logToFile('ERROR', 'Schema check/repair failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { valid: false, needsRebuild: false };
    }
  }
}

export default SchemaManager;
