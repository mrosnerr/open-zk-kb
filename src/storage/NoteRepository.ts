// NoteRepository.ts - Core knowledge management system
// Provides SQLite + FTS5 indexing with Markdown file storage
// FTS5 is manually managed (no triggers) for reliability with TEXT primary keys

import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { expandPath } from '../utils/path.js';
import { logToFile } from '../logger.js';
import { extractWikiLinks as parseAllWikiLinks, parseWikiLink } from '../utils/wikilink.js';
import { SchemaManager } from '../schema.js';
import { cosineSimilarity, blobToEmbedding, embeddingToBlob } from '../embeddings.js';
import type { NoteKind, NoteStatus } from '../types.js';

export interface NoteMetadata {
  id: string;
  path: string;
  title: string;
  kind: NoteKind;
  status: NoteStatus;
  type: 'atomic' | 'moc';
  tags: string[];
  content: string;
  summary?: string;
  guidance?: string;
  context?: string;
  updated_at: number;
  created_at: number;
  word_count: number;
  access_count?: number;
  last_accessed_at?: number;
  related_notes?: string[];
  backlinks_count?: number;
}

export interface NoteLink {
  source_id: string;
  target_id: string;
  link_text: string;
  created_at: number;
}

export interface StoreResult {
  action: 'created' | 'updated' | 'archived' | 'removed';
  path: string;
  id: string;
  previousPath?: string;
}

export interface StoreOptions {
  title?: string;
  kind?: NoteKind;
  status?: NoteStatus;
  type?: 'atomic' | 'moc';
  tags?: string[];
  summary?: string;
  guidance?: string;
  context?: string;
  existingId?: string;
  related?: string[];
}

// Monotonic timestamp tracking to avoid ID collisions within a process
let idCounter = 0;
let lastIdTimestamp = '';

export class NoteRepository {
  protected db: Database;
  protected docsPath: string;
  protected dbPath: string;
  protected schemaManager: SchemaManager;

  constructor(docsPath: string = '~/.local/share/open-zk-kb') {
    try {
      const originalPath = docsPath;
      this.docsPath = expandPath(docsPath);

      if (!this.docsPath || !path.isAbsolute(this.docsPath)) {
        throw new Error(
          `Invalid docs path after expansion: got '${this.docsPath}' from input '${originalPath}'. ` +
          `HOME=${process.env.HOME}, cwd=${process.cwd()}`
        );
      }

      this.dbPath = path.join(this.docsPath, '.index', 'knowledge.db');
      const dbDir = path.dirname(this.dbPath);

      try {
        if (!fs.existsSync(dbDir)) {
          fs.mkdirSync(dbDir, { recursive: true });
        }
      } catch (error) {
        logToFile('ERROR', 'Failed to create database directory', {
          path: dbDir,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(
          `Failed to create database directory at ${dbDir}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }

      try {
        if (!fs.existsSync(this.docsPath)) {
          fs.mkdirSync(this.docsPath, { recursive: true });
        }
      } catch (error) {
        logToFile('ERROR', 'Failed to create docs directory', {
          path: this.docsPath,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(
          `Failed to create docs directory at ${this.docsPath}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }

      this.db = new Database(this.dbPath);
      this.db.run('PRAGMA journal_mode = WAL');

      this.schemaManager = new SchemaManager(this.db);
      this.initializeSchema();
    } catch (error) {
      logToFile('ERROR', 'Constructor failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private initializeSchema(): void {
    this.schemaManager.initialize();

    const { valid, needsRebuild } = this.schemaManager.checkAndRepair();

    if (!valid) {
      logToFile('ERROR', 'Database schema validation failed after repair attempt', {
        dbPath: this.dbPath,
      });
      throw new Error('Failed to initialize database schema');
    }

    if (needsRebuild) {
      logToFile('INFO', 'Schema migration requires full rebuild from files');
      this.rebuildFromFiles();
    }
  }

  private generateId(): string {
    const now = new Date();
    let base = this.formatTimestamp(now);

    // If wall clock hasn't caught up to a previous spin-ahead, keep using the advanced timestamp
    if (base <= lastIdTimestamp) {
      base = lastIdTimestamp;
      idCounter++;
      if (idCounter > 99) {
        base = this.incrementTimestamp(base);
        lastIdTimestamp = base;
        idCounter = 0;
      }
    } else {
      lastIdTimestamp = base;
      idCounter = 0;
    }

    // Always 16-digit: YYYYMMDDHHmmss + 2-digit counter
    return `${base}${String(idCounter).padStart(2, '0')}`;
  }

  private incrementTimestamp(timestamp: string): string {
    const year = Number(timestamp.slice(0, 4));
    const month = Number(timestamp.slice(4, 6)) - 1;
    const day = Number(timestamp.slice(6, 8));
    const hour = Number(timestamp.slice(8, 10));
    const minute = Number(timestamp.slice(10, 12));
    const second = Number(timestamp.slice(12, 14));

    const next = new Date(year, month, day, hour, minute, second);
    next.setSeconds(next.getSeconds() + 1);
    return this.formatTimestamp(next);
  }

  private formatTimestamp(date: Date): string {
    return date.getFullYear().toString() +
      String(date.getMonth() + 1).padStart(2, '0') +
      String(date.getDate()).padStart(2, '0') +
      String(date.getHours()).padStart(2, '0') +
      String(date.getMinutes()).padStart(2, '0') +
      String(date.getSeconds()).padStart(2, '0');
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 60);
  }

  private countWords(content: string): number {
    return content.split(/\s+/).filter(w => w.length > 0).length;
  }

  private extractTitle(content: string): string {
    const lines = content.split('\n');

    for (const line of lines) {
      const match = line.match(/^#+\s+(.+)$/);
      if (match) return match[1].substring(0, 100);
    }

    const firstSentence = content.split(/[.!?]/)[0];
    return firstSentence.substring(0, 100).trim();
  }

  protected buildFrontmatter(metadata: Partial<NoteMetadata>): string {
    const fm: Record<string, unknown> = {
      id: metadata.id,
      title: metadata.title,
      kind: metadata.kind || 'observation',
      status: metadata.status,
      type: metadata.type,
      tags: metadata.tags || [],
      created: new Date(metadata.created_at || Date.now()).toISOString().split('T')[0],
      updated: new Date(metadata.updated_at || Date.now()).toISOString().split('T')[0],
    };

    if (metadata.summary) fm.summary = metadata.summary;
    if (metadata.guidance) fm.guidance = metadata.guidance;
    if (metadata.context) fm.context = metadata.context;
    if (metadata.related_notes && metadata.related_notes.length > 0) {
      fm.related_notes = metadata.related_notes;
    }

    return `---\n${Object.entries(fm)
      .filter(([_, v]) => v !== undefined && v !== null && (Array.isArray(v) ? v.length > 0 : true))
      .map(([k, v]) => {
        if (Array.isArray(v)) return `${k}:\n${(v as string[]).map(item => `  - ${item}`).join('\n')}`;
        return `${k}: ${v}`;
      })
      .join('\n')}\n---\n\n`;
  }

  protected parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
    if (!match) return { frontmatter: {}, body: content };

    const fm: Record<string, unknown> = {};
    const lines = match[1].split('\n');
    let currentKey: string | null = null;

    for (const line of lines) {
      const arrayMatch = line.match(/^(\w+):\s*$/);
      if (arrayMatch) {
        currentKey = arrayMatch[1];
        fm[currentKey] = [];
        continue;
      }

      const itemMatch = line.match(/^\s+-\s+(.+)$/);
      if (itemMatch && currentKey) {
        (fm[currentKey] as string[]).push(itemMatch[1]);
        continue;
      }

      const keyValueMatch = line.match(/^(\w+):\s*(.+)$/);
      if (keyValueMatch) {
        fm[keyValueMatch[1]] = keyValueMatch[2];
        currentKey = null;
      }
    }

    if (fm.related_notes && typeof fm.related_notes === 'string') {
      fm.related_notes = [fm.related_notes];
    }

    return { frontmatter: fm, body: match[2] };
  }

  protected sanitizeFTS5Query(query: string): string {
    if (!query || typeof query !== 'string') return '""';

    const sanitized = query
      .replace(/[:*"(){}[\]^~\\]/g, ' ')
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
      .trim();

    if (!sanitized) return '""';

    const terms = sanitized
      .split(/\s+/)
      .filter(t => t.length > 1)
      .slice(0, 10)
      .map(t => `"${t}"`)
      .join(' OR ');

    return terms || '""';
  }

  // ---- FTS5 manual management ----

  private ftsInsert(id: string, title: string, content: string, tags: string, context: string): void {
    this.db.prepare(`
      INSERT INTO notes_fts(note_id, title, content, tags, context)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, title, content, tags, context);
  }

  private ftsDelete(id: string): void {
    // Delete all FTS rows for this note_id
    this.db.prepare("DELETE FROM notes_fts WHERE note_id = ?").run(id);
  }

  private ftsUpdate(id: string, title: string, content: string, tags: string, context: string): void {
    this.ftsDelete(id);
    this.ftsInsert(id, title, content, tags, context);
  }

  // ---- Main operations ----

  store(
    contentOrOptions: string | (StoreOptions & { content?: string }),
    optionsArg?: StoreOptions
  ): StoreResult {
    const now = Date.now();

    let content: string;
    let options: StoreOptions;

    if (typeof contentOrOptions === 'string') {
      content = contentOrOptions;
      options = optionsArg || {};
    } else {
      content = contentOrOptions.content || '';
      options = contentOrOptions;
    }

    const title = options.title || this.extractTitle(content);
    const id = options.existingId || this.generateId();
    const slug = this.slugify(title);
    const filePath = path.join(this.docsPath, `${id}-${slug}.md`);
    const wordCount = this.countWords(content);
    const noteType = options.type || 'atomic';
    const noteKind = options.kind || 'observation';
    const tagsJson = JSON.stringify(options.tags || []);
    const summaryStr = options.summary || '';
    const guidanceStr = options.guidance || '';
    const contextStr = options.context || '';

    const isUpdate = !!options.existingId;
    const createdAt = isUpdate ?
      (this.db.prepare('SELECT created_at FROM notes WHERE id = ?').get(id) as { created_at: number } | undefined)?.created_at || now :
      now;

    const frontmatter = this.buildFrontmatter({
      id,
      title,
      kind: noteKind,
      status: options.status || 'fleeting',
      type: noteType,
      tags: options.tags || [],
      summary: summaryStr || undefined,
      guidance: guidanceStr || undefined,
      context: options.context,
      related_notes: options.related,
      created_at: createdAt,
      updated_at: now,
    });

    const fullContent = frontmatter + content;

    // If updating, remove old file at different path
    if (isUpdate) {
      const oldNote = this.getById(id);
      if (oldNote && oldNote.path !== filePath && fs.existsSync(oldNote.path)) {
        fs.unlinkSync(oldNote.path);
      }
    }

    fs.writeFileSync(filePath, fullContent, 'utf-8');

    // Update FTS before the INSERT OR REPLACE (delete old entry if exists)
    if (isUpdate) {
      this.ftsDelete(id);
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO notes
      (id, path, title, content, kind, status, type, tags, summary, guidance, context, updated_at, created_at, word_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, filePath, title, content, noteKind,
      options.status || 'fleeting', noteType,
      tagsJson, summaryStr, guidanceStr, contextStr, now, createdAt, wordCount
    );

    // Insert into FTS
    this.ftsInsert(id, title, content, tagsJson, contextStr);

    this.syncLinks(id, content);

    return {
      action: isUpdate ? 'updated' : 'created',
      path: filePath,
      id,
      previousPath: isUpdate ? this.getById(id)?.path : undefined,
    };
  }

  search(query: string, options: {
    status?: NoteStatus;
    kind?: NoteKind;
    tags?: string[];
    context?: string;
    limit?: number;
  } = {}): NoteMetadata[] {
    const sanitizedQuery = this.sanitizeFTS5Query(query);

    let sql = `
      SELECT n.*
      FROM notes_fts fts
      JOIN notes n ON fts.note_id = n.id
      WHERE notes_fts MATCH ?
    `;
    const params: (string | number)[] = [sanitizedQuery];

    if (options.status) {
      sql += ' AND n.status = ?';
      params.push(options.status);
    }

    if (options.kind) {
      sql += ' AND n.kind = ?';
      params.push(options.kind);
    }

    if (options.context) {
      sql += ' AND n.context = ?';
      params.push(options.context);
    }

    if (options.tags && options.tags.length > 0) {
      for (const tag of options.tags) {
        sql += ' AND n.tags LIKE ?';
        params.push(`%"${tag}"%`);
      }
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(options.limit || 10);

    const stmt = this.db.prepare(sql);
    const results = stmt.all(...params) as NoteMetadata[];

    return results.map(r => ({
      ...r,
      kind: (r.kind || 'observation') as NoteKind,
      tags: JSON.parse(r.tags as unknown as string),
    }));
  }

  /**
   * Search notes by vector similarity using cosine distance.
   * Loads embeddings from DB and computes similarity in pure TS.
   * Returns notes sorted by similarity score (highest first).
   */
  searchVector(queryEmbedding: number[], options: {
    status?: NoteStatus;
    kind?: NoteKind;
    limit?: number;
  } = {}): Array<NoteMetadata & { similarity: number }> {
    let sql = `
      SELECT * FROM notes
      WHERE embedding IS NOT NULL
    `;
    const params: (string | number)[] = [];

    if (options.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    if (options.kind) {
      sql += ' AND kind = ?';
      params.push(options.kind);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<NoteMetadata & { embedding: Buffer }>;

    const scored = rows.map(row => {
      const noteEmbedding = blobToEmbedding(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, noteEmbedding);
      return {
        ...row,
        kind: (row.kind || 'observation') as NoteKind,
        tags: JSON.parse(row.tags as unknown as string),
        similarity,
      };
    });

    scored.sort((a, b) => b.similarity - a.similarity);
    const limit = options.limit || 10;
    return scored.slice(0, limit);
  }

  /**
   * Hybrid search: combines FTS5 keyword results with vector similarity results.
   * Uses Reciprocal Rank Fusion (RRF) to merge rankings.
   */
  searchHybrid(
    query: string,
    queryEmbedding: number[] | null,
    options: {
      status?: NoteStatus;
      kind?: NoteKind;
      tags?: string[];
      context?: string;
      limit?: number;
    } = {}
  ): NoteMetadata[] {
    const limit = options.limit || 10;

    const ftsResults = this.search(query, { ...options, limit: limit * 2 });

    if (!queryEmbedding) return ftsResults.slice(0, limit);

    const vecResults = this.searchVector(queryEmbedding, {
      status: options.status,
      kind: options.kind,
      limit: limit * 2,
    });

    let filteredVecResults = vecResults;
    if (options.tags && options.tags.length > 0) {
      filteredVecResults = vecResults.filter(note => {
        const tags = Array.isArray(note.tags) ? note.tags : [];
        const filterTags = options.tags ?? [];
        return filterTags.every(tag => tags.some(t => (t as string).includes(tag)));
      });
    }

    // Reciprocal Rank Fusion — k=60 is standard for balancing recall between rankers
    const k = 60;
    const scores = new Map<string, { score: number; note: NoteMetadata }>();

    ftsResults.forEach((note, rank) => {
      const rrfScore = 1 / (k + rank + 1);
      scores.set(note.id, { score: rrfScore, note });
    });

    filteredVecResults.forEach((note, rank) => {
      const rrfScore = 1 / (k + rank + 1);
      const existing = scores.get(note.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        const { similarity: _, ...noteData } = note;
        scores.set(note.id, { score: rrfScore, note: noteData as NoteMetadata });
      }
    });

    const merged = [...scores.values()].sort((a, b) => b.score - a.score);
    return merged.slice(0, limit).map(entry => entry.note);
  }

  /**
   * Store an embedding for a note. Called after store() when embedding is available.
   */
  storeEmbedding(noteId: string, embedding: number[], model: string): boolean {
    const blob = embeddingToBlob(embedding);
    const result = this.db.prepare(
      'UPDATE notes SET embedding = ?, embedding_model = ? WHERE id = ?'
    ).run(blob, model, noteId);
    return (result as unknown as { changes: number }).changes > 0;
  }

  updateContentHash(noteId: string, hash: string): void {
    this.db.prepare('UPDATE notes SET content_hash = ? WHERE id = ?').run(hash, noteId);
  }

  getNotesWithoutContentHash(limit: number = 100): NoteMetadata[] {
    type NoteRow = Omit<NoteMetadata, 'tags'> & { tags: string };

    const rows = this.db.prepare(`
      SELECT * FROM notes
      WHERE content_hash IS NULL AND status != 'archived'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as NoteRow[];

    return rows.map((row) => ({
      ...row,
      kind: (row.kind || 'observation') as NoteKind,
      tags: JSON.parse(row.tags),
    }));
  }

  findNearDuplicates(hash: string, threshold: number = 3): NoteMetadata[] {
    type NoteRow = Omit<NoteMetadata, 'tags'> & { tags: string; content_hash: string };

    const rows = this.db.prepare(
      "SELECT * FROM notes WHERE content_hash IS NOT NULL AND status != 'archived'"
    ).all() as NoteRow[];

    const targetBigInt = BigInt(`0x${hash}`);
    const matches = rows.filter((row) => {
      const noteBigInt = BigInt(`0x${row.content_hash}`);
      let xor = targetBigInt ^ noteBigInt;
      let count = 0;
      while (xor > 0n) {
        count += Number(xor & 1n);
        xor >>= 1n;
      }
      return count <= threshold;
    });

    return matches.map((row) => ({
      ...row,
      kind: (row.kind || 'observation') as NoteKind,
      tags: JSON.parse(row.tags),
    }));
  }

  findSimHashDuplicates(threshold: number = 3): Map<string, NoteMetadata[]> {
    type NoteRow = Omit<NoteMetadata, 'tags'> & { tags: string; content_hash: string };

    const rows = this.db.prepare(`
      SELECT * FROM notes
      WHERE status != 'archived' AND content_hash IS NOT NULL
      ORDER BY created_at DESC
    `).all() as NoteRow[];

    const notes: Array<NoteMetadata & { content_hash: string }> = rows.map((row) => ({
      ...row,
      kind: (row.kind || 'observation') as NoteKind,
      tags: JSON.parse(row.tags),
    }));

    const groups = new Map<string, NoteMetadata[]>();
    const assigned = new Set<string>();

    for (let i = 0; i < notes.length; i++) {
      const seed = notes[i];
      if (assigned.has(seed.id)) continue;

      const group: Array<NoteMetadata & { content_hash: string }> = [seed];
      assigned.add(seed.id);

      for (let j = i + 1; j < notes.length; j++) {
        const candidate = notes[j];
        if (assigned.has(candidate.id)) continue;

        const seedHash = seed.content_hash;
        const candidateHash = candidate.content_hash;
        const a = BigInt(`0x${seedHash}`);
        const b = BigInt(`0x${candidateHash}`);

        let xor = a ^ b;
        let count = 0;
        while (xor > 0n) {
          count += Number(xor & 1n);
          xor >>= 1n;
        }

        if (count <= threshold) {
          group.push(candidate);
          assigned.add(candidate.id);
        }
      }

      if (group.length >= 2) {
        groups.set(seed.id, group.map(({ content_hash: _contentHash, ...note }) => note));
      }
    }

    return groups;
  }

  getAllContentHashes(): Array<{ id: string; hash: string }> {
    return this.db.prepare(
      'SELECT id, content_hash as hash FROM notes WHERE content_hash IS NOT NULL'
    ).all() as Array<{ id: string; hash: string }>;
  }

  /**
   * Get IDs of notes that don't have embeddings yet.
   */
  getNotesWithoutEmbeddings(limit: number = 50): Array<{ id: string; title: string; summary: string; content: string }> {
    return this.db.prepare(`
      SELECT id, title, summary, content FROM notes
      WHERE embedding IS NULL AND status != 'archived'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as Array<{ id: string; title: string; summary: string; content: string }>;
  }

  /**
   * Get embedding stats for maintenance reporting.
   */
  getEmbeddingStats(): { total: number; withEmbedding: number; withoutEmbedding: number; models: Record<string, number> } {
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as withEmbedding,
        SUM(CASE WHEN embedding IS NULL THEN 1 ELSE 0 END) as withoutEmbedding
      FROM notes WHERE status != 'archived'
    `).get() as { total: number; withEmbedding: number; withoutEmbedding: number };

    const modelRows = this.db.prepare(`
      SELECT embedding_model, COUNT(*) as count
      FROM notes
      WHERE embedding IS NOT NULL AND embedding_model IS NOT NULL
      GROUP BY embedding_model
    `).all() as Array<{ embedding_model: string; count: number }>;

    const models: Record<string, number> = {};
    for (const row of modelRows) {
      models[row.embedding_model] = row.count;
    }

    return { ...counts, models };
  }

  /**
   * Look up notes by exact tag match using SQL LIKE on the JSON tags column.
   * More reliable than FTS5 search + post-filter for tag-based lookups.
   */
  getByTag(tag: string, limit: number = 10): NoteMetadata[] {
    // Tags are stored as JSON arrays, e.g. '["project:myapp","typescript"]'
    const pattern = `%"${tag}"%`;
    const stmt = this.db.prepare(`
      SELECT * FROM notes
      WHERE tags LIKE ? AND status != 'archived'
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    const results = stmt.all(pattern, limit) as NoteMetadata[];
    return results.map(r => ({
      ...r,
      kind: (r.kind || 'observation') as NoteKind,
      tags: JSON.parse(r.tags as unknown as string),
    }));
  }

  getByStatus(status: NoteStatus, limit: number = 50): NoteMetadata[] {
    const stmt = this.db.prepare(`
      SELECT * FROM notes
      WHERE status = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    const results = stmt.all(status, limit) as NoteMetadata[];
    return results.map(r => ({
      ...r,
      kind: (r.kind || 'observation') as NoteKind,
      tags: JSON.parse(r.tags as unknown as string),
    }));
  }

  getByKind(kind: NoteKind, limit: number = 50): NoteMetadata[] {
    const stmt = this.db.prepare(`
      SELECT * FROM notes
      WHERE kind = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    const results = stmt.all(kind, limit) as NoteMetadata[];
    return results.map(r => ({
      ...r,
      kind: (r.kind || 'observation') as NoteKind,
      tags: JSON.parse(r.tags as unknown as string),
    }));
  }

  getById(id: string): NoteMetadata | null {
    const stmt = this.db.prepare('SELECT * FROM notes WHERE id = ?');
    const result = stmt.get(id) as NoteMetadata | undefined;

    if (!result) return null;

    return {
      ...result,
      kind: (result.kind || 'observation') as NoteKind,
      tags: JSON.parse(result.tags as unknown as string),
    };
  }

  getByPath(filePath: string): NoteMetadata | null {
    const stmt = this.db.prepare('SELECT * FROM notes WHERE path = ?');
    const result = stmt.get(filePath) as NoteMetadata | undefined;

    if (!result) return null;

    return {
      ...result,
      kind: (result.kind || 'observation') as NoteKind,
      tags: JSON.parse(result.tags as unknown as string),
    };
  }

  getStaleNotes(reviewAfterDays: number, promotionThreshold: number, excludeKinds: NoteKind[]): NoteMetadata[] {
    const cutoff = Date.now() - (reviewAfterDays * 24 * 60 * 60 * 1000);
    const placeholders = excludeKinds.map(() => '?').join(',');

    let sql = `
      SELECT * FROM notes
      WHERE status = 'fleeting'
        AND created_at < ?
        AND access_count < ?
    `;
    const params: (string | number)[] = [cutoff, promotionThreshold];

    if (excludeKinds.length > 0) {
      sql += ` AND kind NOT IN (${placeholders})`;
      params.push(...excludeKinds);
    }

    sql += ' ORDER BY created_at ASC';

    const results = this.db.prepare(sql).all(...params) as NoteMetadata[];
    return results.map(r => ({
      ...r,
      kind: (r.kind || 'observation') as NoteKind,
      tags: JSON.parse(r.tags as unknown as string),
    }));
  }

  getAll(limit: number = 500): NoteMetadata[] {
    const stmt = this.db.prepare('SELECT * FROM notes ORDER BY updated_at DESC LIMIT ?');
    const results = stmt.all(limit) as NoteMetadata[];
    return results.map(r => ({
      ...r,
      kind: (r.kind || 'observation') as NoteKind,
      tags: JSON.parse(r.tags as unknown as string),
    }));
  }

  /**
   * Get the most frequently accessed notes, prioritizing permanent notes.
   */
  getTopAccessedNotes(limit: number = 10): NoteMetadata[] {
    const stmt = this.db.prepare(`
      SELECT * FROM notes
      WHERE status != 'archived' AND access_count > 0
      ORDER BY 
        CASE status WHEN 'permanent' THEN 0 ELSE 1 END,
        access_count DESC,
        last_accessed_at DESC
      LIMIT ?
    `);
    const results = stmt.all(limit) as NoteMetadata[];
    return results.map(r => ({
      ...r,
      kind: (r.kind || 'observation') as NoteKind,
      tags: JSON.parse(r.tags as unknown as string),
    }));
  }

  /**
   * Get notes accessed within the last N days.
   * Captures "hot" notes from recent sessions.
   */
  getRecentlyAccessedNotes(days: number = 7, limit: number = 10): NoteMetadata[] {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const stmt = this.db.prepare(`
      SELECT * FROM notes
      WHERE status != 'archived' 
        AND last_accessed_at > ?
        AND access_count > 0
      ORDER BY last_accessed_at DESC
      LIMIT ?
    `);
    const results = stmt.all(cutoff, limit) as NoteMetadata[];
    return results.map(r => ({
      ...r,
      kind: (r.kind || 'observation') as NoteKind,
      tags: JSON.parse(r.tags as unknown as string),
    }));
  }

  /**
   * Get relevant notes by balancing recency, frequency, and importance.
   */
  getRelevantNotesForContext(maxNotes: number = 10): NoteMetadata[] {
    const seen = new Set<string>();
    const notes: NoteMetadata[] = [];

    const addUnique = (candidates: NoteMetadata[], max: number) => {
      for (const note of candidates) {
        if (!seen.has(note.id) && notes.length < maxNotes) {
          seen.add(note.id);
          notes.push(note);
          if (notes.length >= max) break;
        }
      }
    };

    // 1. All personalization notes (always relevant - user preferences)
    const personalizations = this.getByKind('personalization', 5)
      .filter(n => n.status === 'permanent');
    addUnique(personalizations, maxNotes);

    // 2. Recently accessed notes (hot in recent sessions - last 7 days)
    const recentlyAccessed = this.getRecentlyAccessedNotes(7, 5);
    addUnique(recentlyAccessed, notes.length + 3);

    // 3. Top accessed permanent notes (proven valuable over time)
    const topAccessed = this.getTopAccessedNotes(5)
      .filter(n => n.status === 'permanent');
    addUnique(topAccessed, notes.length + 3);

    // 4. Recent permanent decisions (fresh context)
    const decisions = this.getByKind('decision', 3)
      .filter(n => n.status === 'permanent');
    addUnique(decisions, notes.length + 2);

    // 5. Recent procedures (actionable knowledge)
    const procedures = this.getByKind('procedure', 3)
      .filter(n => n.status === 'permanent');
    addUnique(procedures, maxNotes);

    return notes.slice(0, maxNotes);
  }

  remove(id: string): boolean {
    const note = this.getById(id);
    if (!note) return false;

    if (fs.existsSync(note.path)) {
      fs.unlinkSync(note.path);
    }

    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    this.ftsDelete(id);
    this.db.prepare('DELETE FROM note_links WHERE source_id = ? OR target_id = ?').run(id, id);

    return true;
  }

  archive(id: string): boolean {
    const note = this.getById(id);
    if (!note) return false;

    const now = Date.now();
    this.db.prepare('UPDATE notes SET status = ?, updated_at = ? WHERE id = ?').run('archived', now, id);
    this.updateFrontmatterStatus(note, 'archived');

    return true;
  }

  promoteToPermanent(id: string): boolean {
    const note = this.getById(id);
    if (!note) return false;

    const now = Date.now();
    this.db.prepare('UPDATE notes SET status = ?, updated_at = ? WHERE id = ?').run('permanent', now, id);
    this.updateFrontmatterStatus(note, 'permanent');

    return true;
  }

  private updateFrontmatterStatus(note: NoteMetadata, newStatus: NoteStatus): void {
    try {
      if (!fs.existsSync(note.path)) return;
      const content = fs.readFileSync(note.path, 'utf-8');
      const { body } = this.parseFrontmatter(content);

      const newFrontmatter = this.buildFrontmatter({
        ...note,
        status: newStatus,
        updated_at: Date.now(),
      });

      fs.writeFileSync(note.path, newFrontmatter + body, 'utf-8');
    } catch (err) {
      logToFile('WARN', 'Failed to update frontmatter status', { noteId: note.id, error: String(err) });
    }
  }

  getStats(): { total: number; fleeting: number; permanent: number; archived: number; other: number } {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'fleeting' THEN 1 ELSE 0 END) as fleeting,
        SUM(CASE WHEN status = 'permanent' THEN 1 ELSE 0 END) as permanent,
        SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived,
        SUM(CASE WHEN status NOT IN ('fleeting', 'permanent', 'archived') THEN 1 ELSE 0 END) as other
      FROM notes
    `);

    return stmt.get() as { total: number; fleeting: number; permanent: number; archived: number; other: number };
  }

  getStatsByKind(): Record<string, { total: number; fleeting: number; permanent: number; archived: number }> {
    const stmt = this.db.prepare(`
      SELECT kind,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'fleeting' THEN 1 ELSE 0 END) as fleeting,
        SUM(CASE WHEN status = 'permanent' THEN 1 ELSE 0 END) as permanent,
        SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived
      FROM notes
      GROUP BY kind
    `);

    const rows = stmt.all() as Array<{ kind: string; total: number; fleeting: number; permanent: number; archived: number }>;
    const result: Record<string, { total: number; fleeting: number; permanent: number; archived: number }> = {};
    for (const row of rows) {
      result[row.kind || 'observation'] = { total: row.total, fleeting: row.fleeting, permanent: row.permanent, archived: row.archived };
    }
    return result;
  }

  recordAccess(id: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE notes
      SET access_count = COALESCE(access_count, 0) + 1,
          last_accessed_at = ?
      WHERE id = ?
    `).run(now, id);
  }

  rebuildFromFiles(): { indexed: number; errors: number } {
    const uniqueIds = new Set<string>();
    let errors = 0;

    // Clear existing data
    this.db.run('DELETE FROM note_links');
    this.db.run('DELETE FROM notes');
    this.db.run('DELETE FROM notes_fts');

    // Scan all .md files
    const files = fs.readdirSync(this.docsPath).filter(f => f.endsWith('.md'));

    for (const file of files) {
      try {
        const filePath = path.join(this.docsPath, file);
        const rawContent = fs.readFileSync(filePath, 'utf-8');
        const { frontmatter, body } = this.parseFrontmatter(rawContent);

        const id = (frontmatter.id as string) || file.match(/^(\d{16}|\d{12})/)?.[1] || '';
        if (!id) {
          errors++;
          continue;
        }

        const title = (frontmatter.title as string) || this.extractTitle(body);
        const kind = (frontmatter.kind as NoteKind) || 'observation';
        const status = (frontmatter.status as NoteStatus) || 'fleeting';
        const noteType = (frontmatter.type as 'atomic' | 'moc') || 'atomic';
        const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
        const summary = (frontmatter.summary as string) || '';
        const guidance = (frontmatter.guidance as string) || '';
        const context = (frontmatter.context as string) || '';
        const wordCount = this.countWords(body);
        const tagsJson = JSON.stringify(tags);

        const createdDate = frontmatter.created ? new Date(frontmatter.created as string).getTime() : Date.now();
        const updatedDate = frontmatter.updated ? new Date(frontmatter.updated as string).getTime() : Date.now();

        this.db.prepare(`
          INSERT OR REPLACE INTO notes
          (id, path, title, content, kind, status, type, tags, summary, guidance, context, updated_at, created_at, word_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, filePath, title, body, kind, status, noteType,
          tagsJson, summary, guidance, context, updatedDate, createdDate, wordCount
        );

        this.ftsDelete(id);
        this.ftsInsert(id, title, body, tagsJson, context);
        this.syncLinks(id, body);
        uniqueIds.add(id);
      } catch (err) {
        logToFile('WARN', 'Failed to index file during rebuild', { file, error: String(err) });
        errors++;
      }
    }

    return { indexed: uniqueIds.size, errors };
  }

  private extractWikiLinks(content: string): string[] {
    return parseAllWikiLinks(content).map(link => link.slug);
  }

  private resolveLink(linkText: string): string | null {
    const parsed = parseWikiLink(linkText);

    const byPath = this.db.prepare('SELECT id FROM notes WHERE path LIKE ?').get(`%/${parsed.slug}.md`) as { id: string } | undefined;
    if (byPath) return byPath.id;

    const byId = this.db.prepare('SELECT id FROM notes WHERE id = ?').get(parsed.id) as { id: string } | undefined;
    if (byId) return byId.id;

    const bySlug = this.db.prepare('SELECT id FROM notes WHERE path LIKE ?').get(`%-${this.slugify(linkText)}.md`) as { id: string } | undefined;
    if (bySlug) return bySlug.id;

    const titleSearch = parsed.display || parsed.slug;
    const byTitle = this.db.prepare('SELECT id FROM notes WHERE title LIKE ?').get(`%${titleSearch}%`) as { id: string } | undefined;
    if (byTitle) return byTitle.id;

    return null;
  }

  syncLinks(noteId: string, content: string): void {
    this.db.prepare('DELETE FROM note_links WHERE source_id = ?').run(noteId);

    const links = this.extractWikiLinks(content);
    const now = Date.now();

    for (const linkText of links) {
      const targetId = this.resolveLink(linkText);
      if (targetId) {
        this.db.prepare(`
          INSERT OR REPLACE INTO note_links (source_id, target_id, link_text, created_at)
          VALUES (?, ?, ?, ?)
        `).run(noteId, targetId, linkText, now);
      }
    }
  }

  getBacklinks(noteId: string): Array<{ note: NoteMetadata; link_text: string }> {
    const stmt = this.db.prepare(`
      SELECT n.*, l.link_text
      FROM note_links l
      JOIN notes n ON l.source_id = n.id
      WHERE l.target_id = ?
      ORDER BY l.created_at DESC
    `);

    const results = stmt.all(noteId) as Array<NoteMetadata & { link_text: string }>;

    return results.map(r => ({
      note: {
        ...r,
        kind: (r.kind || 'observation') as NoteKind,
        tags: JSON.parse(r.tags as unknown as string),
      },
      link_text: r.link_text,
    }));
  }

  getOutgoingLinks(noteId: string): Array<{ note: NoteMetadata; link_text: string }> {
    const stmt = this.db.prepare(`
      SELECT n.*, l.link_text
      FROM note_links l
      JOIN notes n ON l.target_id = n.id
      WHERE l.source_id = ?
      ORDER BY l.created_at DESC
    `);

    const results = stmt.all(noteId) as Array<NoteMetadata & { link_text: string }>;

    return results.map(r => ({
      note: {
        ...r,
        kind: (r.kind || 'observation') as NoteKind,
        tags: JSON.parse(r.tags as unknown as string),
      },
      link_text: r.link_text,
    }));
  }

  getUpgradeStatus(): { total: number; needsSummary: number; needsGuidance: number } {
    const row = this.db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN summary = '' OR summary IS NULL THEN 1 ELSE 0 END) as needsSummary,
        SUM(CASE WHEN guidance = '' OR guidance IS NULL THEN 1 ELSE 0 END) as needsGuidance
      FROM notes WHERE status != 'archived'
    `).get() as { total: number; needsSummary: number; needsGuidance: number };
    return row;
  }

  getNotesMissingFields(): NoteMetadata[] {
    const results = this.db.prepare(`
      SELECT * FROM notes
      WHERE status != 'archived'
        AND (summary = '' OR summary IS NULL OR guidance = '' OR guidance IS NULL)
      ORDER BY updated_at DESC
    `).all() as NoteMetadata[];
    return results.map(r => ({
      ...r,
      kind: (r.kind || 'observation') as NoteKind,
      tags: JSON.parse(r.tags as unknown as string),
    }));
  }

  getByIds(ids: string[]): NoteMetadata[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const results = this.db.prepare(
      `SELECT * FROM notes WHERE id IN (${placeholders})`
    ).all(...ids) as NoteMetadata[];
    return results.map(r => ({
      ...r,
      kind: (r.kind || 'observation') as NoteKind,
      tags: JSON.parse(r.tags as unknown as string),
    }));
  }

  updateSummaryGuidance(id: string, summary: string, guidance: string): boolean {
    const note = this.getById(id);
    if (!note) return false;

    const now = Date.now();
    this.db.prepare(
      'UPDATE notes SET summary = ?, guidance = ?, updated_at = ? WHERE id = ?'
    ).run(summary, guidance, now, id);

    // Update FTS entry
    this.ftsUpdate(id, note.title, note.content, JSON.stringify(note.tags), note.context || '');

    // Update markdown frontmatter (best-effort)
    this.updateFrontmatterFields(note, { summary, guidance });

    return true;
  }

  private updateFrontmatterFields(note: NoteMetadata, fields: { summary?: string; guidance?: string }): void {
    try {
      if (!fs.existsSync(note.path)) return;
      const content = fs.readFileSync(note.path, 'utf-8');
      const { body } = this.parseFrontmatter(content);

      const newFrontmatter = this.buildFrontmatter({
        ...note,
        summary: fields.summary ?? note.summary,
        guidance: fields.guidance ?? note.guidance,
        updated_at: Date.now(),
      });

      fs.writeFileSync(note.path, newFrontmatter + body, 'utf-8');
    } catch (err) {
      logToFile('WARN', 'Failed to update frontmatter fields', { noteId: note.id, error: String(err) });
    }
  }

  getRecentNotes(limit: number = 5): NoteMetadata[] {
    const stmt = this.db.prepare(`
      SELECT * FROM notes 
      WHERE status != 'archived'
      ORDER BY updated_at DESC 
      LIMIT ?
    `);
    const results = stmt.all(limit) as NoteMetadata[];
    return results.map(r => ({
      ...r,
      kind: (r.kind || 'observation') as NoteKind,
      tags: JSON.parse(r.tags as unknown as string),
    }));
  }

  getReviewQueue(
    filter?: 'fleeting' | 'permanent',
    daysThreshold: number = 14,
    limit: number = 3,
    promotionThreshold: number = 2,
    exemptKinds: NoteKind[] = [],
  ): {
    fleeting: { notes: NoteMetadata[]; total: number };
    permanent: { notes: NoteMetadata[]; total: number };
  } {
    const cutoff = Date.now() - (daysThreshold * 24 * 60 * 60 * 1000);

    // Build exempt kinds clause for SQL
    const exemptPlaceholders = exemptKinds.length > 0
      ? ` AND kind NOT IN (${exemptKinds.map(() => '?').join(',')})`
      : '';

    const queryFleeting = (lim: number) => {
      const params: (string | number)[] = [cutoff, promotionThreshold, ...exemptKinds, lim];
      return this.db.prepare(`
        SELECT * FROM notes 
        WHERE status = 'fleeting' 
          AND created_at < ?
          AND access_count < ?
          ${exemptPlaceholders}
        ORDER BY access_count ASC, created_at ASC
        LIMIT ?
      `).all(...params) as NoteMetadata[];
    };

    const countFleeting = () => {
      const params: (string | number)[] = [cutoff, promotionThreshold, ...exemptKinds];
      return this.db.prepare(`
        SELECT COUNT(*) as count FROM notes 
        WHERE status = 'fleeting' AND created_at < ? AND access_count < ?
        ${exemptPlaceholders}
      `).get(...params) as { count: number };
    };

    const queryPermanent = (lim: number) => {
      const params: (string | number)[] = [cutoff, ...exemptKinds, lim];
      return this.db.prepare(`
        SELECT * FROM notes 
        WHERE status = 'permanent' 
          AND created_at < ?
          AND access_count = 0
          ${exemptPlaceholders}
        ORDER BY created_at ASC
        LIMIT ?
      `).all(...params) as NoteMetadata[];
    };

    const countPermanent = () => {
      const params: (string | number)[] = [cutoff, ...exemptKinds];
      return this.db.prepare(`
        SELECT COUNT(*) as count FROM notes 
        WHERE status = 'permanent' AND created_at < ? AND access_count = 0
        ${exemptPlaceholders}
      `).get(...params) as { count: number };
    };

    const mapResult = (r: NoteMetadata) => ({
      ...r,
      kind: (r.kind || 'observation') as NoteKind,
      tags: JSON.parse(r.tags as unknown as string),
    });

    if (filter === 'fleeting') {
      return {
        fleeting: { notes: queryFleeting(limit).map(mapResult), total: countFleeting().count },
        permanent: { notes: [], total: 0 },
      };
    }

    if (filter === 'permanent') {
      return {
        fleeting: { notes: [], total: 0 },
        permanent: { notes: queryPermanent(limit).map(mapResult), total: countPermanent().count },
      };
    }

    return {
      fleeting: { notes: queryFleeting(limit).map(mapResult), total: countFleeting().count },
      permanent: { notes: queryPermanent(limit).map(mapResult), total: countPermanent().count },
    };
  }

  findDuplicates(): Map<string, NoteMetadata[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM notes 
      WHERE status != 'archived'
      ORDER BY title, created_at DESC
    `);
    const results = stmt.all() as NoteMetadata[];
    
    const groups = new Map<string, NoteMetadata[]>();
    for (const r of results) {
      const note: NoteMetadata = {
        ...r,
        kind: (r.kind || 'observation') as NoteKind,
        tags: JSON.parse(r.tags as unknown as string),
      };
      
      const baseTitle = this.normalizeTitle(note.title);
      if (!groups.has(baseTitle)) {
        groups.set(baseTitle, []);
      }
      const group = groups.get(baseTitle);
      if (group) group.push(note);
    }

    for (const [key, notes] of groups) {
      if (notes.length < 2) {
        groups.delete(key);
      }
    }

    return groups;
  }

  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/^(reference|action|decision|research):\s*/i, '')
      .replace(/\.md$/i, '')
      .replace(/[^a-z0-9]/g, '')
      .substring(0, 50);
  }

  clearAll(): void {
    this.db.run('DELETE FROM note_links');
    this.db.run('DELETE FROM notes');
    this.db.run('DELETE FROM notes_fts');
  }

  close(): void {
    this.db.close();
  }
}

export function createNoteRepository(docsPath?: string): NoteRepository {
  return new NoteRepository(docsPath);
}

export default createNoteRepository;
