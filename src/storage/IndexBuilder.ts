// IndexBuilder.ts - Deterministic index generation for project notes
// Pure SQL → markdown rendering. No LLM, no judgment.

import type { NoteMetadata } from './NoteRepository.js';
import { formatNoteLink } from '../utils/wikilink.js';

/** Note kinds displayed in the index, in section order */
const INDEX_SECTION_ORDER: string[] = [
  'domain',
  'decision',
  'procedure',
  'reference',
  'observation',
  'resource',
  'personalization',
];

/** Human-readable section headers */
const SECTION_HEADERS: Record<string, string> = {
  domain: 'Domain',
  decision: 'Decisions',
  procedure: 'Procedures',
  reference: 'References',
  observation: 'Observations',
  resource: 'Resources',
  personalization: 'Personalizations',
};

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toISOString().split('T')[0];
}

function formatDateTime(date: Date = new Date()): string {
  return date.toISOString().replace('T', ' ').substring(0, 16);
}

/**
 * Build the markdown body for a project index note.
 * Pure function: takes notes → returns markdown content (without frontmatter).
 */
export function buildIndexContent(project: string, notes: NoteMetadata[]): string {
  const projectName = project.charAt(0).toUpperCase() + project.slice(1);
  const lines: string[] = [];

  lines.push(`# ${projectName} Index`);
  lines.push('');

  const byKind = new Map<string, NoteMetadata[]>();
  for (const note of notes) {
    const kind = note.kind || 'observation';
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(note);
  }

  for (const kind of INDEX_SECTION_ORDER) {
    const kindNotes = byKind.get(kind);
    if (!kindNotes || kindNotes.length === 0) continue;

    const header = SECTION_HEADERS[kind] || kind;
    const count = kindNotes.length;

    if (kind === 'domain') {
      lines.push(`## ${header}`);
    } else {
      lines.push(`## ${header} (${count})`);
    }

    for (const note of kindNotes) {
      const link = formatNoteLink(note);
      const summary = note.summary || '';
      const date = formatDate(note.created_at);

      if (kind === 'domain') {
        lines.push(`- ${link}${summary ? ` — ${summary}` : ''}`);
      } else if (kind === 'decision') {
        lines.push(`- ${link}${summary ? ` — ${summary}` : ''} (${date})`);
      } else {
        lines.push(`- ${link}${summary ? ` — ${summary}` : ''}`);
      }
    }

    lines.push('');
  }

  for (const [kind, kindNotes] of byKind) {
    if (INDEX_SECTION_ORDER.includes(kind)) continue;
    const header = kind.charAt(0).toUpperCase() + kind.slice(1);
    lines.push(`## ${header} (${kindNotes.length})`);
    for (const note of kindNotes) {
      const link = formatNoteLink(note);
      const summary = note.summary || '';
      lines.push(`- ${link}${summary ? ` — ${summary}` : ''}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`Last rebuilt: ${formatDateTime()}`);

  return lines.join('\n');
}
