import { NoteRepository } from '../storage/NoteRepository.js';
import { renderNoteForAgent } from '../prompts.js';
import { getConfig } from '../config.js';
import { logToFile } from '../logger.js';
import type { NoteMetadata } from '../storage/NoteRepository.js';

export interface KbContext {
  domainNote: NoteMetadata | null;
  recentNotes: NoteMetadata[];
  project: string;
}

export function createReadonlyRepo(): NoteRepository | null {
  try {
    const testVault = process.env.NODE_ENV === 'test' ? process.env.__OPEN_ZK_KB_TEST_VAULT : undefined;
    const vault = testVault || getConfig().vault;
    return new NoteRepository(vault, { readonly: true });
  } catch (error) {
    logToFile('WARN', 'opencode-plugin: failed to open read-only repository', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function fetchKbContext(repo: NoteRepository, project: string): KbContext {
  const tag = `project:${project}`;
  const domainNote = repo.getDomainNote(project);

  const ftsQuery = domainNote
    ? `${domainNote.title} ${domainNote.summary || ''}`
    : project;

  let recentNotes = repo.search(ftsQuery, {
    tags: [tag],
    status: 'permanent' as const,
    limit: 6,
  });

  if (domainNote) {
    recentNotes = recentNotes.filter(n => n.id !== domainNote.id);
  }

  recentNotes = recentNotes.filter(n => n.kind !== 'index' && n.kind !== 'log');
  recentNotes = recentNotes.slice(0, 5);

  return { domainNote, recentNotes, project };
}

function buildInjectionBanner(ctx: KbContext): string {
  const allNotes = ctx.domainNote
    ? [ctx.domainNote, ...ctx.recentNotes]
    : ctx.recentNotes;

  const total = allNotes.length;
  if (total === 0) return '';

  const counts: Record<string, number> = {};
  for (const note of allNotes) {
    const kind = note.kind || 'observation';
    counts[kind] = (counts[kind] || 0) + 1;
  }

  const kindSummary = Object.entries(counts)
    .map(([kind, count]) => `${count} ${kind}${count > 1 ? 's' : ''}`)
    .join(', ');

  return `> **Knowledge Base**: ${total} note${total > 1 ? 's' : ''} injected (${kindSummary})\n`;
}

export function formatContext(ctx: KbContext): string {
  const parts: string[] = [];

  parts.push(`## Knowledge Base Context (project: ${ctx.project})\n`);

  const banner = buildInjectionBanner(ctx);
  if (banner) {
    parts.push(banner);
  }

  parts.push('Before storing structured notes, run `knowledge-template --kind {kind}` for the canonical structure.\n');

  if (ctx.domainNote) {
    parts.push('### Domain Note');
    parts.push(renderNoteForAgent(ctx.domainNote));
    parts.push('');
  }

  if (ctx.recentNotes.length > 0) {
    parts.push('### Key Notes');
    for (const note of ctx.recentNotes) {
      parts.push(renderNoteForAgent(note));
    }
    parts.push('');
  }

  if (!ctx.domainNote && ctx.recentNotes.length === 0) {
    return '';
  }

  return parts.join('\n');
}
