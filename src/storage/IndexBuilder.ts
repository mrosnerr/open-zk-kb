// IndexBuilder.ts - Deterministic index generation for project notes
// Pure SQL → markdown rendering. No LLM, no judgment.

import type { NoteMetadata } from './NoteRepository.js';
import { formatNoteLink } from '../utils/wikilink.js';

const KIND_DIR_MAP: Record<string, string> = {
  decision: 'decisions',
  reference: 'references',
  procedure: 'procedures',
  observation: 'observations',
  resource: 'resources',
};

export interface MocSplitConfig {
  threshold: number;
  previewCount: number;
}

export interface KindSubMoc {
  kind: string;
  dirName: string;
  content: string;
}

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

export function buildIndexContent(
  project: string,
  notes: NoteMetadata[],
  splitConfig?: MocSplitConfig,
): { content: string; subMocs: KindSubMoc[] } {
  const projectName = project.charAt(0).toUpperCase() + project.slice(1);
  const lines: string[] = [];
  const subMocs: KindSubMoc[] = [];
  const shouldSplit = splitConfig && notes.length >= splitConfig.threshold;

  lines.push(`# ${projectName} Index (${notes.length} notes)`);
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
    const dirName = KIND_DIR_MAP[kind] || `${kind}s`;

    // Split to sub-MOC: project exceeds threshold AND kind has 5+ notes
    if (shouldSplit && kind !== 'domain' && count >= 5) {
      const subMocPath = `projects/${project}/${dirName}/index`;
      lines.push(`## [[${subMocPath}\\|${header}]] (${count})`);

      const preview = kindNotes.slice(0, splitConfig!.previewCount);
      for (const note of preview) {
        const link = formatNoteLink(note);
        const summary = note.summary || '';
        lines.push(`- ${link}${summary ? ` — ${summary}` : ''}`);
      }
      if (count > splitConfig!.previewCount) {
        lines.push(`→ *[[${subMocPath}\\|View all ${count}]]*`);
      }
      lines.push('');

      subMocs.push({
        kind,
        dirName,
        content: buildKindSubMocContent(project, kind, header, kindNotes),
      });
      continue;
    }

    if (kind === 'domain') {
      lines.push(`## ${header}`);
    } else {
      lines.push(`## ${header} (${count})`);
    }

    for (const note of kindNotes) {
      renderNoteInIndex(lines, note, kind);
    }

    lines.push('');
  }

  for (const [kind, kindNotes] of byKind) {
    if (INDEX_SECTION_ORDER.includes(kind)) continue;
    const header = kind.charAt(0).toUpperCase() + kind.slice(1);
    lines.push(`## ${header} (${kindNotes.length})`);
    for (const note of kindNotes) {
      renderNoteInIndex(lines, note, kind);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`Last rebuilt: ${formatDateTime()}`);

  return { content: lines.join('\n'), subMocs };
}

function renderNoteInIndex(lines: string[], note: NoteMetadata, kind: string): void {
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

function buildKindSubMocContent(project: string, kind: string, header: string, notes: NoteMetadata[]): string {
  const projectName = project.charAt(0).toUpperCase() + project.slice(1);
  const lines: string[] = [];

  lines.push(`# ${projectName} — ${header} (${notes.length})`);
  lines.push('');

  for (const note of notes) {
    renderNoteInIndex(lines, note, kind);
  }

  lines.push('');
  lines.push(`↑ [[projects/${project}/index\\|Back to ${projectName}]]`);
  lines.push('');
  lines.push('---');
  lines.push(`Last rebuilt: ${formatDateTime()}`);

  return lines.join('\n');
}

export interface ProjectStat {
  project: string;
  noteCount: number;
  lastActive: number;
}

export function buildGlobalIndexContent(
  projectStats: ProjectStat[],
  preferencesCount: number,
  generalCount: number,
  fleetingCount: number,
): string {
  const lines: string[] = [];

  lines.push('# Knowledge Base');
  lines.push('');

  if (projectStats.length > 0) {
    const sorted = [...projectStats].sort((a, b) => b.lastActive - a.lastActive);
    lines.push(`## Projects (${sorted.length})`);
    lines.push('| Project | Notes | Last Active |');
    lines.push('|---------|-------|-------------|');
    for (const stat of sorted) {
      const date = stat.lastActive ? formatDate(stat.lastActive) : '—';
      lines.push(`| [[projects/${stat.project}/index\\|${stat.project}]] | ${stat.noteCount} | ${date} |`);
    }
    lines.push('');
  }

  if (preferencesCount > 0) {
    lines.push(`## Preferences — ${preferencesCount} notes`);
    lines.push('');
  }

  if (generalCount > 0) {
    lines.push(`## [[general/index\\|General]] — ${generalCount} notes`);
    lines.push('');
  }

  if (fleetingCount > 0) {
    lines.push(`## [[review\\|📝 Needs Review]] — ${fleetingCount} fleeting notes`);
    lines.push('');
  }

  lines.push('---');
  lines.push(`Last rebuilt: ${formatDateTime()}`);

  return lines.join('\n');
}

export function buildGeneralIndexContent(notes: NoteMetadata[]): string {
  const lines: string[] = [];

  lines.push('# General Knowledge');
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
