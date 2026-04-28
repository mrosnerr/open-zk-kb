// ReviewBuilder.ts - Deterministic review queue generation for fleeting notes
// Pure markdown rendering. No LLM, no judgment.

import type { NoteMetadata } from './NoteRepository.js';
import { formatNoteLink } from '../utils/wikilink.js';
import { extractProjectFromTags } from './path-resolver.js';

function formatDateTime(date: Date = new Date()): string {
  return date.toISOString().replace('T', ' ').substring(0, 16);
}

function daysSince(timestamp: number): number {
  return Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24));
}

export function buildReviewContent(fleetingNotes: NoteMetadata[]): string {
  const lines: string[] = [];

  lines.push(`# 📝 Needs Review (${fleetingNotes.length} fleeting notes)`);
  lines.push('');

  if (fleetingNotes.length === 0) {
    lines.push('No fleeting notes pending review.');
    lines.push('');
    lines.push('---');
    lines.push(`Last rebuilt: ${formatDateTime()}`);
    return lines.join('\n');
  }

  const byProject = new Map<string, NoteMetadata[]>();
  for (const note of fleetingNotes) {
    const project = extractProjectFromTags(note.tags) || '_unscoped';
    const bucket = byProject.get(project);
    if (bucket) {
      bucket.push(note);
    } else {
      byProject.set(project, [note]);
    }
  }

  const sortedProjects = [...byProject.keys()].sort((a, b) => {
    if (a === '_unscoped') return 1;
    if (b === '_unscoped') return -1;
    return a.localeCompare(b);
  });

  for (const project of sortedProjects) {
    const notes = byProject.get(project);
    if (!notes) continue;
    notes.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
    const label = project === '_unscoped' ? 'Unscoped' : project;
    lines.push(`## ${label} (${notes.length})`);

    for (const note of notes) {
      const link = formatNoteLink(note);
      const age = daysSince(note.created_at);
      const ageStr = age === 0 ? 'today' : age === 1 ? '1 day old' : `${age} days old`;
      lines.push(`- ${link} — ${note.kind}, ${ageStr}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`Last rebuilt: ${formatDateTime()}`);

  return lines.join('\n');
}
