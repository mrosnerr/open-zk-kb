// schema.ts - Database schema management
// Provides CREATE TABLE IF NOT EXISTS with PRAGMA user_version migration support

import { Database } from 'bun:sqlite';
import { logToFile } from './logger.js';

export class SchemaManager {
  static readonly SCHEMA_VERSION = 5;

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
      description: 'Add content_hash column and capture_metrics table',
      migrate: (db) => {
        const columns = db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'content_hash')) {
          db.run('ALTER TABLE notes ADD COLUMN content_hash TEXT DEFAULT NULL');
        }

        db.run(`CREATE TABLE IF NOT EXISTS capture_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern_name TEXT NOT NULL,
          pattern_type TEXT NOT NULL,
          source TEXT NOT NULL,
          score INTEGER NOT NULL,
          gate_called BOOLEAN DEFAULT 0,
          gate_worthy BOOLEAN DEFAULT NULL,
          gate_confidence REAL DEFAULT NULL,
          note_id TEXT DEFAULT NULL,
          created_at INTEGER NOT NULL
        )`);

        db.run('CREATE INDEX IF NOT EXISTS idx_capture_metrics_created ON capture_metrics(created_at)');
        db.run('CREATE INDEX IF NOT EXISTS idx_capture_metrics_pattern ON capture_metrics(pattern_name)');
        db.run('CREATE INDEX IF NOT EXISTS idx_notes_content_hash ON notes(content_hash)');
      },
    },
  ];

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
        content_hash TEXT DEFAULT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS capture_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_name TEXT NOT NULL,
        pattern_type TEXT NOT NULL,
        source TEXT NOT NULL,
        score INTEGER NOT NULL,
        gate_called BOOLEAN DEFAULT 0,
        gate_worthy BOOLEAN DEFAULT NULL,
        gate_confidence REAL DEFAULT NULL,
        note_id TEXT DEFAULT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_capture_metrics_created ON capture_metrics(created_at)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_capture_metrics_pattern ON capture_metrics(pattern_name)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_notes_content_hash ON notes(content_hash)');

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
