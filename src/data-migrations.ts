// data-migrations.ts - Agent-driven data migrations that run through MCP API
// Schema (DDL) migrations live in schema.ts; these are content-level migrations.

import type { NoteRepository, NoteMetadata } from './storage/NoteRepository.js';
import { KIND_GUIDANCE } from './prompts.js';

// ---- Migration interface ----

export interface DataMigration {
  id: string;
  version: number;
  description: string;
  dependsOn?: string[];

  /** Which notes need this migration */
  detect(repo: NoteRepository): NoteMetadata[];

  /** Instructions embedded in upgrade-read response (tells the model what to generate) */
  instructions: string;

  /** Which note fields to include in the read response */
  readFields: ('content' | 'summary' | 'guidance' | 'context')[];

  /** Schema for the fields the model returns in upgrade-apply */
  applyFields: Record<string, string>;

  /** Apply one update (partial merge — only touches specified fields) */
  apply(repo: NoteRepository, noteId: string, fields: Record<string, string>): boolean;
}

export interface PendingMigration {
  id: string;
  version: number;
  description: string;
  pending: number;
  status: 'ready' | 'blocked';
  blockedBy?: string[];
}

// ---- Migration registry ----

const kindExamples = Object.entries(KIND_GUIDANCE)
  .map(([kind, guidance]) => `  - ${kind}: guidance like "${guidance}"`)
  .join('\n');

const v3SummaryGuidance: DataMigration = {
  id: 'v3-summary-guidance',
  version: 1,
  description: 'Add summary and guidance fields to notes missing them',

  detect(repo: NoteRepository): NoteMetadata[] {
    return repo.getNotesMissingFields();
  },

  instructions: `For each note, generate:
- summary: One-line present-tense key takeaway (e.g., "User prefers Tailwind CSS utility classes over Bootstrap"). This is what agents see first in search results and context injection.
- guidance: Imperative actionable instruction for agents — how to apply this knowledge (e.g., "Use Tailwind when suggesting CSS frameworks or reviewing CSS code"). Falls back to kind-specific default if omitted.

Kind-specific guidance examples:
${kindExamples}`,

  readFields: ['content'],

  applyFields: {
    summary: 'One-line key takeaway, present tense',
    guidance: 'Actionable instruction for agents, imperative voice',
  },

  apply(repo: NoteRepository, noteId: string, fields: Record<string, string>): boolean {
    const summary = fields.summary || '';
    const guidance = fields.guidance || '';
    if (!summary && !guidance) return false;
    return repo.updateSummaryGuidance(noteId, summary, guidance);
  },
};

/** Ordered registry of all data migrations */
export const DATA_MIGRATIONS: DataMigration[] = [
  v3SummaryGuidance,
];

// ---- Helpers ----

/** Returns all migrations with pending counts and blocked/ready status */
export function getPendingMigrations(repo: NoteRepository): PendingMigration[] {
  const completedIds = new Set<string>();
  const results: PendingMigration[] = [];

  for (const migration of DATA_MIGRATIONS) {
    const pending = migration.detect(repo).length;

    // A migration is "complete" when detect() returns 0
    if (pending === 0) {
      completedIds.add(migration.id);
      continue;
    }

    // Check dependency status
    const blockedBy = (migration.dependsOn || []).filter(depId => !completedIds.has(depId));
    const status = blockedBy.length > 0 ? 'blocked' : 'ready';

    results.push({
      id: migration.id,
      version: migration.version,
      description: migration.description,
      pending,
      status,
      blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
    });
  }

  return results;
}

/** Look up a migration by ID */
export function getMigrationById(id: string): DataMigration | undefined {
  return DATA_MIGRATIONS.find(m => m.id === id);
}
