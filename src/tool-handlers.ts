// tool-handlers.ts - Handler functions for knowledge tools

import type { NoteKind, NoteStatus, AppConfig } from './types.js';
import { KIND_DEFAULT_STATUS } from './types.js';

const VALID_STATUSES = new Set<string>(['fleeting', 'permanent', 'archived']);

function toNoteStatus(status: string | undefined, fallback: NoteStatus): NoteStatus {
  if (status && VALID_STATUSES.has(status)) return status as NoteStatus;
  return fallback;
}
import type { NoteRepository, NoteMetadata } from './storage/NoteRepository.js';
import { formatWikiLink } from './utils/wikilink.js';
import { renderNoteForAgent, renderNoteForSearch } from './prompts.js';
import { getPendingMigrations, getMigrationById } from './data-migrations.js';
import { logToFile } from './logger.js';
import { computeSimHash } from './utils/simhash.js';
import type { EmbeddingConfig } from './embeddings.js';
import { generateEmbedding, generateEmbeddingBatch, buildEmbeddingText } from './embeddings.js';
import { getLatestVersion, isNewerVersion } from './utils/version-check.js';
import { getAgentDocsTargets } from './agent-docs-targets.js';
import { injectAgentDocs, inspectAgentDocs } from './agent-docs.js';
import { detectClient, isVisibleToClient, getClientTags, clientTag, isKnownClient } from './client-heuristics.js';

// ---- Constants ----

/** Soft word-count guidelines per note kind (not hard limits). */
export const KIND_WORD_GUIDELINES: Record<NoteKind, { target: number; warn: number }> = {
  personalization: { target: 50, warn: 80 },
  decision:        { target: 150, warn: 250 },
  procedure:       { target: 150, warn: 250 },
  reference:       { target: 120, warn: 200 },
  observation:     { target: 100, warn: 200 },
  resource:        { target: 50, warn: 100 },
};

/** Absolute word-count ceiling — warns regardless of kind. */
export const ABSOLUTE_WARN_THRESHOLD = 300;

// ---- Helper functions ----

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function atomicityWarning(kind: NoteKind, wordCount: number): string | null {
  const guide = KIND_WORD_GUIDELINES[kind];
  if (wordCount > ABSOLUTE_WARN_THRESHOLD) {
    return `\n\n⚠ This note is ${wordCount} words (target for ${kind}: ~${guide.target}). Consider splitting into separate atomic notes — each note should capture one concept.`;
  }
  if (wordCount > guide.warn) {
    return `\n\n⚠ This note is ${wordCount} words (target for ${kind}: ~${guide.target}). Consider whether it captures more than one concept.`;
  }
  return null;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function getRecommendation(note: NoteMetadata, daysOld: number, promotionThreshold: number = 2): string {
  const accesses = note.access_count || 0;
  if (accesses >= promotionThreshold) return '2caa Promote';
  if (accesses === 0 && daysOld > 30) return '1f44 Archive';
  return '1f914 Review';
}

// ---- Arg types ----

export interface StoreArgs {
  title: string;
  content: string;
  kind: NoteKind;
  status?: string;
  tags?: string[];
  summary: string;
  guidance: string;
  project?: string;
  client?: string;
  related?: string[];
}

export interface SearchArgs {
  query: string;
  kind?: NoteKind;
  status?: string;
  project?: string;
  client?: string;
  tags?: string[];
  limit?: number;
}

export interface MaintainArgs {
  action: string;
  noteId?: string;
  filter?: 'fleeting' | 'permanent';
  days?: number;
  limit?: number;
  dryRun?: boolean;
}

function describeAgentDocsStatus(status: ReturnType<typeof inspectAgentDocs>['status']): string {
  switch (status) {
    case 'healthy': return 'healthy';
    case 'start-only': return 'malformed (start marker only)';
    case 'end-only': return 'malformed (end marker only)';
    case 'out-of-order': return 'malformed (markers out of order)';
    case 'multiple-markers': return 'malformed (multiple markers)';
    default: return 'no managed block';
  }
}

// ---- Handlers ----

export function handleStore(args: StoreArgs, repo: NoteRepository, embeddingConfig?: EmbeddingConfig | null): string {
  const effectiveStatus = toNoteStatus(args.status, KIND_DEFAULT_STATUS[args.kind]);
  const tags = [...(args.tags || [])];

  if (args.project) {
    const projectTag = `project:${args.project}`;
    if (!tags.includes(projectTag)) {
      tags.push(projectTag);
    }
  }

  // Client tag — explicit or auto-detected from content/guidance
  const resolvedClient = args.client || detectClient(args.content, args.guidance);
  if (resolvedClient) {
    const tag = clientTag(resolvedClient);
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }

  let content = args.content;
  if (args.related && args.related.length > 0) {
    const links = args.related.map(id => {
      const existing = repo.getById(id);
      if (existing) {
        return formatWikiLink({ id, display: existing.title });
      }
      return formatWikiLink({ id });
    });
    content += '\n\n## Related\n' + links.map(l => `- ${l}`).join('\n');
  }

  const result = repo.store(content, {
    title: args.title,
    kind: args.kind,
    status: effectiveStatus,
    tags,
    summary: args.summary,
    guidance: args.guidance,
    related: args.related,
  });

  const hashContent = args.summary || args.content || args.title;
  const hash = computeSimHash(hashContent);
  repo.updateContentHash(result.id, hash);

  if (embeddingConfig) {
    const text = buildEmbeddingText(args.title, args.summary, args.content);
    void generateEmbedding(text, embeddingConfig).then(embResult => {
      if (embResult) {
        repo.storeEmbedding(result.id, embResult.embedding, embResult.model);
      }
    }).catch(error => {
      logToFile('WARN', 'Embedding generation failed', {
        noteId: result.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  let output = `Knowledge stored (${result.action})\n`;
  output += `ID: ${result.id}\n`;
  output += `Kind: ${args.kind}\n`;
  output += `Status: ${effectiveStatus}\n`;
  output += `Path: ${result.path}`;

  const wordCount = countWords(args.content);
  const warning = atomicityWarning(args.kind, wordCount);
  if (warning) {
    output += warning;
  }

  if (args.client && !isKnownClient(args.client)) {
    output += `\n\n⚠ Unrecognized client "${args.client}". Known clients: opencode, claude-code, cursor, windsurf, zed.`;
  }

  return output;
}

export function handleSearch(args: SearchArgs, repo: NoteRepository, queryEmbedding?: number[] | null): string {
  let results = repo.searchHybrid(args.query, queryEmbedding || null, {
    kind: args.kind,
    status: args.status ? toNoteStatus(args.status, 'fleeting') : undefined,
    tags: args.tags,
    limit: args.limit || 10,
  });

  if (args.project) {
    const projectPrefix = `project:${args.project}`;
    results = results.filter(note => {
      const tags = Array.isArray(note.tags) ? note.tags : [];
      return tags.some(t => t === projectPrefix || t.startsWith(projectPrefix));
    });
  }

  if (args.client) {
    results = results.filter(note => {
      const tags = Array.isArray(note.tags) ? note.tags : [];
      return isVisibleToClient(tags, args.client!);
    });
  }

  const clientWarning = args.client && !isKnownClient(args.client)
    ? `\n⚠ Unrecognized client "${args.client}". Known clients: opencode, claude-code, cursor, windsurf, zed.\n`
    : '';

  if (results.length === 0) {
    return 'No matching notes found. Try broader keywords or remove filters.' + clientWarning;
  }

  let output = `Found ${results.length} note(s):\n\n`;
  for (const note of results) {
    output += renderNoteForSearch(note) + '\n';
    try {
      repo.recordAccess(note.id);
    } catch (error) {
      logToFile('WARN', 'Failed to record access', {
        noteId: note.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return output + clientWarning;
}

export async function handleMaintain(args: MaintainArgs, repo: NoteRepository, config: AppConfig, embeddingConfig?: EmbeddingConfig | null, currentVersion?: string): Promise<string> {
  switch (args.action) {
    case 'stats': {
      const stats = repo.getStats();
      const kindStats = repo.getStatsByKind();
      const upgradeStatus = repo.getUpgradeStatus();
      const embeddingStats = repo.getEmbeddingStats();
      let output = '# Knowledge Base Statistics\n\n';
      output += `## Vault (${stats.total} notes)\n`;
      output += `- Fleeting: ${stats.fleeting}\n`;
      output += `- Permanent: ${stats.permanent}\n`;
      output += `- Archived: ${stats.archived}\n`;
      if (stats.other > 0) {
        output += `- Other (unknown status): ${stats.other}\n`;
      }
      output += '\n## By Kind\n';
      for (const [kind, s] of Object.entries(kindStats)) {
        output += `- **${kind}**: ${s.total} total\n`;
      }
      if (embeddingStats.total > 0 || embeddingConfig) {
        output += '\n## Embeddings\n';
        if (embeddingConfig) {
          output += `- Provider: ${embeddingConfig.provider} (${embeddingConfig.model})\n`;
        }
        output += `- Embedded: ${embeddingStats.withEmbedding}/${embeddingStats.total} notes\n`;
      }
      if (upgradeStatus.needsSummary > 0 || upgradeStatus.needsGuidance > 0) {
        output += '\n## Upgrade Status\n';
        output += `- Notes missing summary: ${upgradeStatus.needsSummary}/${upgradeStatus.total}\n`;
        output += `- Notes missing guidance: ${upgradeStatus.needsGuidance}/${upgradeStatus.total}\n`;
      }
      if (stats.total > 0) {
        const recentNotes = repo.getRecentNotes(5);
        output += '\n## Recent Notes\n';
        for (const note of recentNotes) {
          const status = note.status === 'permanent' ? '🔒' : note.status === 'archived' ? '📦' : '📝';
          output += `- ${status} **${note.title}** (${note.kind})\n`;
        }
        if (stats.total > 5) {
          output += `\nShowing 5 of ${stats.total}. Use \`knowledge-search\` to find specific notes.\n`;
        }
      }
      if (currentVersion) {
        const latest = await getLatestVersion('open-zk-kb');
        if (latest && isNewerVersion(currentVersion, latest)) {
          output += `\n## Update Available\n`;
          output += `- Current: ${currentVersion} | Latest: ${latest}\n`;
          output += `- Run \`bunx open-zk-kb@latest install --client <name> --force\` to update\n`;
        }
      }
      return output;
    }
    case 'promote': {
      if (!args.noteId) return 'Error: noteId is required for promote action.';
      const note = repo.getById(args.noteId);
      if (!note) return `Note not found: ${args.noteId}`;
      repo.promoteToPermanent(args.noteId);
      return `Promoted "${note.title}" (${args.noteId}) to permanent status.`;
    }
    case 'archive': {
      if (!args.noteId) return 'Error: noteId is required for archive action.';
      const note = repo.getById(args.noteId);
      if (!note) return `Note not found: ${args.noteId}`;
      repo.archive(args.noteId);
      return `Archived "${note.title}" (${args.noteId}).`;
    }
    case 'delete': {
      if (!args.noteId) return 'Error: noteId is required for delete action.';
      const note = repo.getById(args.noteId);
      if (!note) return `Note not found: ${args.noteId}`;
      repo.remove(args.noteId);
      return `Deleted "${note.title}" (${args.noteId}).`;
    }
    case 'rebuild': {
      const result = repo.rebuildFromFiles();
      return `Indexed ${result.indexed} notes, ${result.errors} errors\nRebuild complete.`;
    }
    case 'upgrade': {
      const pending = getPendingMigrations(repo);
      if (pending.length === 0) {
        const status = repo.getUpgradeStatus();
        if (status.needsSummary === 0 && status.needsGuidance === 0) {
          return 'All notes have summary and guidance fields. No upgrade needed.';
        }
      }
      let output = '## Upgrade Status\n\n';
      const status = repo.getUpgradeStatus();
      output += `${status.needsSummary} of ${status.total} notes are missing summary fields.\n`;
      output += `${status.needsGuidance} of ${status.total} notes are missing guidance fields.\n`;
      if (pending.length > 0) {
        output += '\n## Pending Migrations\n';
        for (const m of pending) {
          output += `- **${m.id}** (v${m.version}): ${m.description} — ${m.pending} pending [${m.status}]\n`;
        }
      }
      return output;
    }
    case 'upgrade-read': {
      const migrationId = args.noteId; // reuse noteId field for migration ID
      if (!migrationId) return 'Error: noteId (migration ID) is required for upgrade-read action.';
      const migration = getMigrationById(migrationId);
      if (!migration) return `Unknown migration: ${migrationId}`;
      const notes = migration.detect(repo);
      if (notes.length === 0) return 'No pending notes for this migration.';
      let output = `## Migration: ${migration.id}\n\n`;
      output += `${migration.instructions}\n\n`;
      output += `### Pending Notes (${notes.length})\n\n`;
      for (const note of notes.slice(0, 10)) {
        output += `<note id="${note.id}" title="${note.title}" kind="${note.kind}">\n`;
        for (const field of migration.readFields) {
          const value = note[field as keyof typeof note];
          if (value) output += `  <${field}>${value}</${field}>\n`;
        }
        output += `</note>\n\n`;
      }
      if (notes.length > 10) {
        output += `... and ${notes.length - 10} more. Use offset/limit to paginate.\n`;
      }
      return output;
    }
    case 'upgrade-apply': {
      // This action expects noteId and fields passed through args
      // In practice the agent calls this per-note
      if (!args.noteId) return 'Error: noteId is required for upgrade-apply action.';
      return `Use knowledge-store with existingId to update note ${args.noteId}.`;
    }
    case 'review': {
      const daysThreshold = args.days || config.lifecycle.reviewAfterDays;
      const limit = args.limit || 3;
      const queue = repo.getReviewQueue(args.filter, daysThreshold, limit, config.lifecycle.promotionThreshold, config.lifecycle.exemptKinds);
      
      let output = '## Review Queue\n\n';
      
      const hasFleeting = queue.fleeting.total > 0;
      const hasPermanent = queue.permanent.total > 0;
      
      if (!hasFleeting && !hasPermanent) {
        return 'No notes pending review. All notes are up to date!';
      }
      
      if (hasFleeting) {
        output += `### Fleeting Notes for Review (${queue.fleeting.total} total`;
        if (queue.fleeting.notes.length < queue.fleeting.total) {
          output += `, showing ${queue.fleeting.notes.length}`;
        }
        output += ')\n';
        
        for (let i = 0; i < queue.fleeting.notes.length; i++) {
          const note = queue.fleeting.notes[i];
          const daysOld = Math.floor((Date.now() - note.created_at) / (1000 * 60 * 60 * 24));
          const accessInfo = note.access_count === 0 ? 'never accessed' : `${note.access_count} access${note.access_count === 1 ? '' : 'es'}`;
          const rec = getRecommendation(note, daysOld, config.lifecycle.promotionThreshold);
          output += `${i + 1}. "${note.title}" | ${formatDate(note.created_at)} | ${accessInfo} | ${rec}\n`;
        }
        
        if (queue.fleeting.total > queue.fleeting.notes.length) {
          output += `\n... ${queue.fleeting.total - queue.fleeting.notes.length} more. Use \`--filter fleeting --limit 10\` to see all.\n`;
        }
        output += '\n';
      }
      
      if (hasPermanent) {
        output += `### Permanent Notes for Review (${queue.permanent.total} total`;
        if (queue.permanent.notes.length < queue.permanent.total) {
          output += `, showing ${queue.permanent.notes.length}`;
        }
        output += ')\n';
        
        for (let i = 0; i < queue.permanent.notes.length; i++) {
          const note = queue.permanent.notes[i];
          const daysOld = Math.floor((Date.now() - note.created_at) / (1000 * 60 * 60 * 24));
          output += `${i + 1}. "${note.title}" | ${formatDate(note.created_at)} | never accessed | 2999 Review relevance\n`;
        }
        
        if (queue.permanent.total > queue.permanent.notes.length) {
          output += `\n... ${queue.permanent.total - queue.permanent.notes.length} more. Use \`--filter permanent --limit 10\` to see all.\n`;
        }
        output += '\n';
      }
      
      // Flag oversized notes that may need splitting
      const allNotes = repo.getAll(Number.MAX_SAFE_INTEGER);
      const oversized = allNotes
        .filter(n => n.status !== 'archived')
        .map(n => ({ ...n, wordCount: countWords(n.content) }))
        .filter(n => {
          const guide = KIND_WORD_GUIDELINES[n.kind as NoteKind];
          return guide ? n.wordCount > guide.warn : n.wordCount > ABSOLUTE_WARN_THRESHOLD;
        })
        .sort((a, b) => b.wordCount - a.wordCount);

      if (oversized.length > 0) {
        output += `### Oversized Notes (${oversized.length} may need splitting)\n`;
        for (const n of oversized) {
          const guide = KIND_WORD_GUIDELINES[n.kind as NoteKind];
          const target = guide ? guide.target : '?';
          output += `- "${n.title}" (${n.kind}) — ${n.wordCount} words (target: ~${target}) [${n.id}]\n`;
        }
        output += '\n';
      }

      output += '## Next Steps:\n';
      let stepIdx = 65;
      if (hasFleeting) output += `[${String.fromCharCode(stepIdx++)}] Show all fleeting notes for review\n`;
      if (hasPermanent) output += `[${String.fromCharCode(stepIdx++)}] Show all permanent notes for review\n`;
      output += `[${String.fromCharCode(stepIdx++)}] Promote specific note to permanent (requires --noteId)\n`;
      output += `[${String.fromCharCode(stepIdx++)}] Archive specific note (requires --noteId)\n`;
      if (oversized.length > 0) output += `[${String.fromCharCode(stepIdx++)}] Split an oversized note into atomic notes\n`;

      return output;
    }
    case 'dedupe': {
      const unhashed = repo.getNotesWithoutContentHash(500);
      let backfilled = 0;
      for (const note of unhashed) {
        const hashContent = note.summary || note.content || note.title;
        if (!hashContent) continue;
        const hash = computeSimHash(hashContent);
        repo.updateContentHash(note.id, hash);
        backfilled++;
      }
      if (backfilled > 0) {
        logToFile('INFO', 'Backfilled content hashes during dedupe', { count: backfilled });
      }

      const titleDuplicates = repo.findDuplicates();
      const simhashDuplicates = repo.findSimHashDuplicates();

      if (titleDuplicates.size === 0 && simhashDuplicates.size === 0) {
        const backfillMsg = backfilled > 0 ? ` Backfilled ${backfilled} content hash${backfilled === 1 ? '' : 'es'}.` : '';
        return `No duplicate notes found.${backfillMsg}`;
      }

      let output = '## Duplicate Detection\n\n';
      if (backfilled > 0) {
        output += `*Backfilled ${backfilled} content hash${backfilled === 1 ? '' : 'es'} for SimHash comparison.*\n\n`;
      }

      if (titleDuplicates.size > 0) {
        output += `### Title-Based Duplicates (${titleDuplicates.size} groups)\n\n`;

        let groupNum = 1;
        for (const [, notes] of titleDuplicates) {
          output += `**Group ${groupNum}: "${notes[0].title}" (${notes.length} notes)**\n`;
          notes.sort((a, b) => (b.access_count || 0) - (a.access_count || 0));

          for (let i = 0; i < notes.length; i++) {
            const note = notes[i];
            const isPermanent = note.status === 'permanent';
            const marker = isPermanent ? '🔒 (permanent - protected)' : (i === 0 ? '(keep)' : '(duplicate)');
            output += `- ${note.id} | ${note.status} | ${note.access_count || 0} accesses | ${marker}\n`;
          }

          const archivable = notes.filter((n, i) => i > 0 && n.status !== 'permanent');
          if (archivable.length > 0) {
            output += `\n**Recommendation:** Archive ${archivable.map((n) => n.id).join(', ')}\n`;
          } else {
            output += '\n**Note:** All duplicates are permanent — manual review needed.\n';
          }

          output += '\n';
          groupNum++;

          if (groupNum > 10) {
            output += `... and ${titleDuplicates.size - 10} more groups.\n\n`;
            break;
          }
        }
      }

      if (simhashDuplicates.size > 0) {
        output += `### Content-Based Near-Duplicates (${simhashDuplicates.size} groups)\n\n`;

        let groupNum = 1;
        for (const [, notes] of simhashDuplicates) {
          output += `**Group ${groupNum} (${notes.length} notes)**\n`;
          notes.sort((a, b) => (b.access_count || 0) - (a.access_count || 0));

          for (let i = 0; i < notes.length; i++) {
            const note = notes[i];
            const isPermanent = note.status === 'permanent';
            const marker = isPermanent ? '🔒 (permanent - protected)' : (i === 0 ? '(keep)' : '(near-duplicate)');
            output += `- ${note.id} | "${note.title}" | ${note.status} | ${marker}\n`;
          }

          const archivable = notes.filter((n, i) => i > 0 && n.status !== 'permanent');
          if (archivable.length > 0) {
            output += `\n**Recommendation:** Archive ${archivable.map((n) => n.id).join(', ')}\n`;
          }

          output += '\n';
          groupNum++;

          if (groupNum > 10) {
            output += `... and ${simhashDuplicates.size - 10} more groups.\n\n`;
            break;
          }
        }
      }

      output += '## Next Steps:\n';
      output += '[A] Archive specific duplicate (requires --noteId)\n';
      output += '[B] View specific note details (use knowledge-search)\n';
      output += '\n⚠️ Permanent notes (🔒) are never auto-archived. Promote the best version before archiving others.\n';

      return output;
    }
    case 'embed': {
      if (!embeddingConfig) {
        return 'Embedding not configured. Add provider + embeddings section to config.yaml to enable vector search.';
      }

      const notesWithout = repo.getNotesWithoutEmbeddings(args.limit || 50);
      if (notesWithout.length === 0) {
        return 'All notes already have embeddings. Nothing to backfill.';
      }

      if (args.dryRun) {
        return `Dry run: Would generate embeddings for ${notesWithout.length} notes using ${embeddingConfig.model}.`;
      }

      const texts = notesWithout.map(n => buildEmbeddingText(n.title, n.summary || '', n.content));
      const noteIds = notesWithout.map(n => n.id);

      try {
        const results = await generateEmbeddingBatch(texts, embeddingConfig, 60000);
        let stored = 0;
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result) {
            repo.storeEmbedding(noteIds[i], result.embedding, result.model);
            stored++;
          }
        }
        logToFile('INFO', 'Embed backfill completed', { requested: noteIds.length, stored });
        return `Embedded ${stored}/${notesWithout.length} notes using ${embeddingConfig.model}.`;
      } catch (err) {
        return `Embedding failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case 'agent-docs': {
      const dryRun = args.dryRun !== false;
      const targets = getAgentDocsTargets();
      let output = '## Agent Docs Maintenance\n\n';
      output += dryRun
        ? 'Dry run only. No files were modified.\n\n'
        : 'Repaired eligible agent docs files while preserving non-marker content.\n\n';

      for (const target of targets) {
        const inspection = inspectAgentDocs(target.filePath);
        output += `### ${target.name}\n`;
        output += `- Path: ${target.filePath}\n`;
        output += `- Status: ${describeAgentDocsStatus(inspection.status)}\n`;

        if (!inspection.exists) {
          output += '- Result: file not found\n\n';
          continue;
        }

        if (inspection.status === 'healthy') {
          if (dryRun) {
            output += '- Result: would refresh managed instructions to current template\n\n';
          } else {
            const result = injectAgentDocs(target.filePath, target.instructionSize, false, target.client);
            output += `- Result: ${result.action}\n\n`;
          }
          continue;
        }

        if (inspection.status === 'multiple-markers') {
          output += '- Result: manual review recommended; skipped to avoid touching ambiguous content\n\n';
          continue;
        }

        if (dryRun) {
          output += '- Result: would repair markers and append a fresh managed block while preserving other content\n\n';
        } else {
          const result = injectAgentDocs(target.filePath, target.instructionSize, false, target.client);
          output += `- Result: ${result.action}\n\n`;
        }
      }

      output += 'Use `dryRun: false` to apply conservative repairs.';
      return output;
    }
    case 'scope-audit': {
      const dryRun = args.dryRun !== false;
      const allNotes = repo.getAll(Number.MAX_SAFE_INTEGER).filter(n => n.status !== 'archived');
      const misScoped: Array<{ note: NoteMetadata; detected: string }> = [];
      const perClient = new Map<string, number>();
      let universalCount = 0;

      for (const note of allNotes) {
        const tags = Array.isArray(note.tags) ? note.tags : [];
        const currentClients = getClientTags(tags);
        const detected = detectClient(note.content, note.guidance || '');

        if (currentClients.length === 0 && !detected) {
          universalCount++;
        } else if (currentClients.length > 0) {
          for (const c of currentClients) {
            perClient.set(c, (perClient.get(c) || 0) + 1);
          }
        }

        if (detected && currentClients.length === 0) {
          misScoped.push({ note, detected });
        }
      }

      let output = '## Scope Audit\n\n';
      output += `Total non-archived notes: ${allNotes.length}\n`;
      output += `Universal (no client tag): ${universalCount}\n`;
      if (perClient.size > 0) {
        output += '\nPer-client:\n';
        for (const [client, count] of [...perClient.entries()].sort()) {
          const marker = isKnownClient(client) ? '' : ' ⚠ unrecognized';
          output += `- ${clientTag(client)}: ${count}${marker}\n`;
        }
      }

      // Flag notes with unrecognized client tags
      const unknownClientNotes = allNotes.filter(n => {
        const clients = getClientTags(Array.isArray(n.tags) ? n.tags : []);
        return clients.some(c => !isKnownClient(c));
      });

      if (misScoped.length === 0 && unknownClientNotes.length === 0) {
        output += '\nNo mis-scoped notes found. All notes are correctly tagged.';
        return output;
      }

      output += `\n### Mis-scoped Notes (${misScoped.length})\n`;
      output += dryRun ? '*Dry run — no changes applied.*\n\n' : '';

      for (const { note, detected } of misScoped) {
        output += `- "${note.title}" [${note.id}] — detected: ${clientTag(detected)}, current: (none)\n`;

        if (!dryRun) {
          const updatedTags = [...(note.tags || []), clientTag(detected)];
          repo.updateTags(note.id, updatedTags);
        }
      }

      if (unknownClientNotes.length > 0) {
        output += `\n### Unrecognized Client Tags (${unknownClientNotes.length})\n`;
        output += 'Known clients: opencode, claude-code, cursor, windsurf, zed.\n\n';
        for (const note of unknownClientNotes) {
          const unknown = getClientTags(note.tags).filter(c => !isKnownClient(c));
          output += `- "${note.title}" [${note.id}] — unknown: ${unknown.map(c => clientTag(c)).join(', ')}\n`;
        }
      }

      if (misScoped.length > 0 && dryRun) {
        output += '\nUse `dryRun: false` to apply fixes for mis-scoped notes.';
      } else if (misScoped.length > 0) {
        output += `\nFixed ${misScoped.length} mis-scoped note(s).`;
      }

      return output;
    }
    default:
      return `Unknown action: ${args.action}`;
  }
}
