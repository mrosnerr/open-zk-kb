// IndexBuilder.ts - Deterministic index generation for project notes
// Server owns shell pages; Dataview owns list rendering inside those shells.

import type { NoteMetadata } from './NoteRepository.js';
import {
  KIND_DIR_MAP,
  getGeneralFolderNoteBasename,
  getGlobalHomeNoteBasename,
  getKindFolderNoteBasename,
  getPreferencesFolderNoteBasename,
  getProjectFolderNoteBasename,
} from './path-resolver.js';

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

const SECTION_ICONS: Record<string, string> = {
  domain: 'compass',
  decision: 'scale',
  procedure: 'list-checks',
  reference: 'book-open',
  observation: 'lightbulb',
  resource: 'external-link',
  personalization: 'user-cog',
};

const SECTION_DESCRIPTIONS: Record<string, string> = {
  decision: 'Architectural choices and trade-offs',
  procedure: 'Step-by-step workflows and recurring tasks',
  reference: 'Technical facts and documentation',
  observation: 'Insights and verified gotchas',
  resource: 'Links, tools, and libraries',
  personalization: 'Personal style, habits, and tool preferences',
};

const SECTION_COLORS: Record<string, string> = {
  decision: 'var(--color-orange-rgb)',
  procedure: 'var(--color-green-rgb)',
  reference: 'var(--color-blue-rgb)',
  observation: 'var(--color-yellow-rgb)',
  resource: 'var(--color-cyan-rgb)',
  personalization: 'var(--color-pink-rgb)',
};

const QUICKADD_CHOICE_LABELS: Record<string, string> = {
  decision: 'Project Decision',
  observation: 'Project Observation',
  procedure: 'Project Procedure',
  reference: 'Project Reference',
  resource: 'Project Resource',
  personalization: 'Project Preference',
};

const GENERAL_QUICKADD_CHOICE_LABELS: Record<string, string> = {
  decision: 'Decision \u2014 choices & tradeoffs',
  observation: 'Observation \u2014 things you noticed',
  procedure: 'Procedure \u2014 step-by-step workflows',
  reference: 'Reference \u2014 sources & excerpts',
  resource: 'Resource \u2014 tools & URLs',
  personalization: 'Preference \u2014 personal habits',
};


function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toISOString().split('T')[0];
}

function formatDateTime(date: Date = new Date()): string {
  return date.toISOString().replace('T', ' ').substring(0, 16);
}

function groupNotesByKind(notes: NoteMetadata[]): Map<string, NoteMetadata[]> {
  const byKind = new Map<string, NoteMetadata[]>();
  for (const note of notes) {
    const kind = note.kind || 'observation';
    const bucket = byKind.get(kind);
    if (bucket) {
      bucket.push(note);
    } else {
      byKind.set(kind, [note]);
    }
  }
  return byKind;
}

function getSectionHeader(kind: string): string {
  return SECTION_HEADERS[kind] || kind.charAt(0).toUpperCase() + kind.slice(1);
}

function getSingularLabel(kind: string, header: string): string {
  if (kind === 'personalization') return 'Preference';
  if (kind === 'decision') return 'Decision';
  if (kind === 'procedure') return 'Procedure';
  if (kind === 'reference') return 'Reference';
  if (kind === 'observation') return 'Observation';
  if (kind === 'resource') return 'Resource';
  if (kind === 'domain') return 'Domain';
  return header.endsWith('s') ? header.slice(0, -1) : header;
}

function buildQuickAddUri(project: string, kind: string): string | null {
  const choice = QUICKADD_CHOICE_LABELS[kind];
  if (!choice) return null;

  const params = new URLSearchParams({
    choice,
    'value-scope': 'project',
    'value-project': project,
    'value-kind': kind,
  });
  return `obsidian://quickadd?${params.toString().replace(/\+/g, '%20')}`;
}

function buildGeneralQuickAddUri(kind: string): string | null {
  const choice = GENERAL_QUICKADD_CHOICE_LABELS[kind];
  if (!choice) return null;

  const params = new URLSearchParams({
    choice,
    'value-scope': 'general',
  });
  return `obsidian://quickadd?${params.toString().replace(/\+/g, '%20')}`;
}

function buildSectionHeader(kind: string, header: string, project: string, linkedPath?: string): string {
  const icon = SECTION_ICONS[kind];
  const iconPrefix = icon ? `\`[!!${icon}]\` ` : '';
  const title = linkedPath
    ? `[[${linkedPath}|${header}]]`
    : header;
  const quickAddUri = buildQuickAddUri(project, kind);
  const addLink = quickAddUri ? ` [+](${quickAddUri})` : '';
  return `## ${iconPrefix}${title}${addLink}`;
}


function buildDataviewTable(source: string, kind: string, header: string, whereClause?: string): string[] {
  const singular = getSingularLabel(kind, header);
  const folderNoteBasename = source.split('/').at(-1) || getKindFolderNoteBasename(kind);
  const lines = [
    '```dataviewjs',
    `const pages = dv.pages('"${source}"')`,
    `  .where(p => p.file.name !== "${folderNoteBasename}")`,
    '  .sort(p => p.created, "desc");',
    `dv.table(["${singular}", "Tagline", "Created", " "], pages.map(p => {`,
    '  const actions = dv.el("span", "", { cls: "dataview-actions" });',
    '  const editBtn = actions.createEl("a", { cls: "dv-action-btn", attr: { "aria-label": "Edit", title: "Edit this note" } });',
    '  obsidian.setIcon(editBtn, "pencil");',
    '  editBtn.addEventListener("click", async (e) => {',
    '    e.preventDefault();',
    '    const confirmed = confirm(`Edit "${p.title || p.file.name}"?\\n\\nChanges to notes affect AI assistant behavior. Edits to title, summary, and guidance fields are used by agents across sessions.`);',
    '    if (confirmed) { const f = app.vault.getAbstractFileByPath(p.file.path); if (f) { const leaf = app.workspace.getLeaf("tab"); await leaf.openFile(f, { state: { mode: "source" } }); } }',
    '  });',
     '  const delBtn = actions.createEl("a", { cls: "dv-action-btn dv-action-btn-destructive", attr: { "aria-label": "Delete", title: "Delete this note" } });',
     '  obsidian.setIcon(delBtn, "trash-2");',
     '  delBtn.addEventListener("click", async (e) => {',
     '    e.preventDefault();',
     '    const file = app.vault.getAbstractFileByPath(p.file.path);',
     '    if (!file) { new Notice("File not found"); return; }',
     '    const confirmed = confirm(`Delete "${file.name}"? This moves it to trash.`);',
     '    if (confirmed) { await app.vault.trash(file, true); const row = delBtn.closest("tr"); if (row) row.remove(); new Notice("Deleted: " + file.name); }',
     '  });',
     '  const label = p.title || p.file.name.replace(/^\\d{16}-/, "");',
     '  return [dv.fileLink(p.file.path, false, label), p.tagline || "", p.created || "", actions];',
    '}));',
    '```',
  ];

  if (whereClause) {
    lines.splice(3, 0, `  .where(${whereClause})`);
  }

  return lines;
}

 function buildDomainDataviewTable(source: string): string[] {
  return [
    '```dataviewjs',
    `const pages = dv.pages('"${source}"').where(p => p.file.name === "domain");`,
    'dv.table(["Domain", "Tagline", " "], pages.map(p => {',
    '  const actions = dv.el("span", "", { cls: "dataview-actions" });',
    '  const editBtn = actions.createEl("a", { cls: "dv-action-btn", attr: { "aria-label": "Edit", title: "Edit this note" } });',
    '  obsidian.setIcon(editBtn, "pencil");',
    '  editBtn.addEventListener("click", async (e) => {',
    '    e.preventDefault();',
    '    const confirmed = confirm(`Edit "${p.title || p.file.name}"?\\n\\nChanges to notes affect AI assistant behavior. Edits to title, summary, and guidance fields are used by agents across sessions.`);',
    '    if (confirmed) { const f = app.vault.getAbstractFileByPath(p.file.path); if (f) { const leaf = app.workspace.getLeaf("tab"); await leaf.openFile(f, { state: { mode: "source" } }); } }',
    '  });',
    '  const delBtn = actions.createEl("a", { cls: "dv-action-btn dv-action-btn-destructive", attr: { "aria-label": "Delete", title: "Delete this note" } });',
    '  obsidian.setIcon(delBtn, "trash-2");',
    '  delBtn.addEventListener("click", async (e) => {',
    '    e.preventDefault();',
    '    const file = app.vault.getAbstractFileByPath(p.file.path);',
    '    if (!file) { new Notice("File not found"); return; }',
    '    const confirmed = confirm(`Delete "${file.name}"? This moves it to trash.`);',
    '    if (confirmed) { await app.vault.trash(file, true); const row = delBtn.closest("tr"); if (row) row.remove(); new Notice("Deleted: " + file.name); }',
    '  });',
    '  const label = p.title || p.file.name.replace(/^\\d{16}-/, "");',
    '  return [dv.fileLink(p.file.path, false, label), p.tagline || "", actions];',
     '}));',
     '```',
   ];
 }
function buildProjectTagWhereClause(project: string): string {
  const bareTag = JSON.stringify(`project:${project}`);
  const hashTag = JSON.stringify(`#project:${project}`);
  return `p => p.file.tags && (p.file.tags.includes(${bareTag}) || p.file.tags.includes(${hashTag}))`;
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

  lines.push(`# ${projectName}`);
  lines.push('`[!!info|Project knowledge base — decisions, procedures, and references|var(--color-blue-rgb)]`');
  lines.push('');

  const byKind = groupNotesByKind(notes);

  for (const kind of INDEX_SECTION_ORDER) {
    const kindNotes = byKind.get(kind);
    if (!kindNotes || kindNotes.length === 0) continue;

    const header = getSectionHeader(kind);
    const dirName = KIND_DIR_MAP[kind] || `${kind}s`;

    if (kind !== 'domain') {
      subMocs.push({
        kind,
        dirName,
        content: buildKindSubMocContent(project, kind, header),
      });
    }

    if (kind === 'domain') {
      lines.push('## Domain');
      lines.push('');
      lines.push(...buildDomainDataviewTable(`projects/${project}`));
      lines.push('');
      continue;
    }

    const linkedPath = shouldSplit && kindNotes.length >= 5
      ? `projects/${project}/${dirName}/${getKindFolderNoteBasename(dirName)}`
      : undefined;
    lines.push(buildSectionHeader(kind, header, project, linkedPath));
    lines.push('');
    const source = kind === 'personalization'
      ? 'preferences'
      : `projects/${project}/${dirName}`;
    const whereClause = kind === 'personalization'
      ? buildProjectTagWhereClause(project)
      : undefined;
    lines.push(...buildDataviewTable(source, kind, header, whereClause));
    lines.push('');
  }

  for (const [kind] of byKind) {
    if (INDEX_SECTION_ORDER.includes(kind)) continue;
    const header = getSectionHeader(kind);
    const dirName = KIND_DIR_MAP[kind] || `${kind}s`;

    subMocs.push({
      kind,
      dirName,
      content: buildKindSubMocContent(project, kind, header),
    });

    lines.push(buildSectionHeader(kind, header, project));
    lines.push('');
    lines.push(...buildDataviewTable(`projects/${project}/${dirName}`, kind, header));
    lines.push('');
  }

  lines.push('## 📖 Activity');
  lines.push('');
  lines.push(`- [[projects/${project}/log|Operations Log]] — Recent changes to this project`);
  lines.push('');
  lines.push('---');
  lines.push(`Last rebuilt: ${formatDateTime()}`);

  return { content: lines.join('\n'), subMocs };
}

function buildKindSubMocContent(project: string, kind: string, header: string): string {
  const projectName = project.charAt(0).toUpperCase() + project.slice(1);
  const lines: string[] = [];

  lines.push(buildShellFrontmatter({
    kind: 'index',
    title: `${projectName} ${header}`,
    'BC-folder-note': true,
    'BC-folder-note-field': 'up',
    aliases: [header],
    cssclasses: ['folder-note-shell'],
    up: `[[projects/${project}/${getProjectFolderNoteBasename(project)}|${projectName}]]`,
  }).trimEnd());
  lines.push('');
  const icon = SECTION_ICONS[kind];
  const iconPrefix = icon ? `\`[!!${icon}]\` ` : '';
  const quickAddUri = buildQuickAddUri(project, kind);
  const addLink = quickAddUri ? ` [+](${quickAddUri})` : '';
  lines.push(`# ${iconPrefix}${projectName} — ${header}${addLink}`);
  lines.push('');
  lines.push('');
  const source = kind === 'personalization'
    ? 'preferences'
    : `projects/${project}/${KIND_DIR_MAP[kind] || `${kind}s`}`;
  const whereClause = kind === 'personalization'
    ? buildProjectTagWhereClause(project)
    : undefined;
  lines.push(...buildDataviewTable(source, kind, header, whereClause));
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

function buildShellFrontmatter(fields: Record<string, string | boolean | string[]>): string {
  return `---\n${Object.entries(fields).map(([k, v]) => {
    if (Array.isArray(v)) {
      return `${k}:\n${v.map(item => `  - "${item.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join('\n')}`;
    }
    if (typeof v === 'boolean') {
      return `${k}: ${v}`;
    }
    return `${k}: "${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }).join('\n')}\n---\n`;
}

export function buildGlobalIndexContent(
  projectStats: ProjectStat[],
  preferencesCount: number,
  generalCount: number,
  fleetingCount: number,
  totalNoteCount: number,
  options?: {
    includeReviewLink?: boolean;
    includeGlobalLogLink?: boolean;
  },
): string {
  const lines: string[] = [];
  const includeReviewLink = options?.includeReviewLink !== false;
  const includeGlobalLogLink = options?.includeGlobalLogLink !== false;

  lines.push('---');
  lines.push('cssclasses:');
  lines.push('  - dashboard');
  lines.push('  - folder-note-shell');
  lines.push('kind: index');
  lines.push('title: Home');
  lines.push('BC-folder-note: true');
  lines.push('aliases:');
  lines.push('  - Home');
  lines.push('---');
  lines.push('');
  lines.push('# `[!!brain]` Knowledge Base');
  lines.push('`[!!info|Persistent memory for AI assistants|var(--color-purple-rgb)]`');
  lines.push('');
  lines.push('> [!abstract]');
  lines.push(`> **${totalNoteCount}** notes · **${projectStats.length}** projects · Last updated: ${formatDateTime()}`);
  lines.push('');

  if (projectStats.length > 0) {
    const sorted = [...projectStats].sort((a, b) => b.lastActive - a.lastActive);
    lines.push('## Projects');
    lines.push('| Project | Notes | Last Active |');
    lines.push('|---------|-------|-------------|');
    for (const stat of sorted) {
      const date = stat.lastActive ? formatDate(stat.lastActive) : '—';
      lines.push(`| [[projects/${stat.project}/${getProjectFolderNoteBasename(stat.project)}\\|${stat.project}]] | ${stat.noteCount} | ${date} |`);
    }
    lines.push('');
  }

  lines.push('## Browse');
  lines.push('| Section | Notes | Description |');
  lines.push('|---------|-------|-------------|');
  lines.push(`| [[general/${getGeneralFolderNoteBasename()}\\|General Knowledge]] | ${generalCount} | Unscoped references, decisions, observations |`);
  lines.push(`| [[preferences/${getPreferencesFolderNoteBasename()}\\|Preferences]] | ${preferencesCount} | Personal style, habits, and tool preferences |`);
  if (includeReviewLink) {
    lines.push(`| [[review\\|Needs Review]] | ${fleetingCount} | Fleeting notes awaiting promotion or archive |`);
  }
  lines.push('');

  if (includeGlobalLogLink) {
    lines.push('## Activity');
    lines.push('');
    lines.push('- [[log|Operations Log]] — Recent knowledge capture events');
    lines.push('');
  }

  lines.push('## 🔗 Resources');
  lines.push('');
  lines.push('- [Documentation](https://github.com/mrosnerr/open-zk-kb#readme) — Setup, configuration, note kinds');
  lines.push('- [Report an Issue](https://github.com/mrosnerr/open-zk-kb/issues/new) — Bug reports and feature requests');
  lines.push('- [Changelog](https://github.com/mrosnerr/open-zk-kb/releases) — What\'s new');
  lines.push('');

  lines.push('---');
  lines.push('*Powered by [open-zk-kb](https://github.com/mrosnerr/open-zk-kb) · MIT License*');

  return lines.join('\n');
}

export function buildProjectsIndexContent(projectStats: ProjectStat[]): string {
  const lines: string[] = [];

  lines.push(buildShellFrontmatter({
    kind: 'index',
    title: 'Projects',
    'BC-folder-note': true,
    'BC-folder-note-field': 'up',
    aliases: ['Projects'],
    cssclasses: ['folder-note-shell'],
    up: `[[${getGlobalHomeNoteBasename()}|Home]]`,
  }).trimEnd());
  lines.push('');
  lines.push('# `[!!folder-open]` Projects');
  lines.push('`[!!info|Project-scoped knowledge organized by domain|var(--color-blue-rgb)]`');
  lines.push('');

  if (projectStats.length === 0) {
    lines.push('No projects yet.');
  } else {
    const sorted = [...projectStats].sort((a, b) => b.lastActive - a.lastActive);
    lines.push('| Project | Notes | Last Active |');
    lines.push('|---------|-------|-------------|');
    for (const stat of sorted) {
      const date = stat.lastActive ? formatDate(stat.lastActive) : '—';
      lines.push(`| [[projects/${stat.project}/${getProjectFolderNoteBasename(stat.project)}\\|${stat.project}]] | ${stat.noteCount} | ${date} |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push(`Last rebuilt: ${formatDateTime()}`);

  return lines.join('\n');
}

export function buildGeneralIndexContent(notes: NoteMetadata[]): string {
  const lines: string[] = [];

  lines.push(buildShellFrontmatter({
    kind: 'index',
    title: 'General Knowledge',
    'BC-folder-note': true,
    aliases: ['General'],
    cssclasses: ['folder-note-shell'],
    up: `[[${getGlobalHomeNoteBasename()}|Home]]`,
  }).trimEnd());
  lines.push('');
  lines.push('# `[!!library]` General Knowledge');
  lines.push('`[!!info|Cross-cutting notes without a project scope|var(--color-cyan-rgb)]`');
  lines.push('');

  const byKind = groupNotesByKind(notes);

  for (const kind of INDEX_SECTION_ORDER) {
    const kindNotes = byKind.get(kind);
    if (!kindNotes || kindNotes.length === 0) continue;

    const header = getSectionHeader(kind);
    const source = kind === 'personalization'
      ? 'preferences'
      : `general/${KIND_DIR_MAP[kind] || `${kind}s`}`;

    const generalAddUri = buildGeneralQuickAddUri(kind);
    const addLink = generalAddUri ? ` [+](${generalAddUri})` : '';
    lines.push(`## ${header}${addLink}`);
    lines.push('');
    lines.push(...buildDataviewTable(source, kind, header));
    lines.push('');
  }

  lines.push('---');
  lines.push(`Last rebuilt: ${formatDateTime()}`);

  return lines.join('\n');
}

export function buildPreferencesIndexContent(_notes: NoteMetadata[]): string {
  const lines: string[] = [];

  lines.push(buildShellFrontmatter({
    kind: 'index',
    title: 'Preferences',
    'BC-folder-note': true,
    'BC-folder-note-field': 'up',
    aliases: ['Preferences'],
    cssclasses: ['folder-note-shell'],
    up: `[[${getGlobalHomeNoteBasename()}|Home]]`,
  }).trimEnd());
  lines.push('');
  const prefsAddUri = buildGeneralQuickAddUri('personalization');
  const prefsAddLink = prefsAddUri ? ` [+](${prefsAddUri})` : '';
  lines.push(`# \`[!!user-cog]\` Preferences${prefsAddLink}`);
  lines.push('`[!!info|Personal style, habits, and tool preferences|var(--color-pink-rgb)]`');
  lines.push('');
  lines.push(...buildDataviewTable('preferences', 'personalization', 'Preferences'));
  lines.push('');
  lines.push('---');
  lines.push(`Last rebuilt: ${formatDateTime()}`);

  return lines.join('\n');
}

export function buildGeneralKindIndexContent(kind: string, _notes: NoteMetadata[]): string {
  const header = getSectionHeader(kind);
  const lines: string[] = [];

  lines.push(buildShellFrontmatter({
    kind: 'index',
    title: `General ${header}`,
    'BC-folder-note': true,
    'BC-folder-note-field': 'up',
    aliases: [header],
    cssclasses: ['folder-note-shell'],
    up: `[[general/${getGeneralFolderNoteBasename()}|General]]`,
  }).trimEnd());
  lines.push('');
  lines.push(`# General — ${header}`);
  const kindDesc = SECTION_DESCRIPTIONS[kind];
  const kindColor = SECTION_COLORS[kind];
  const kindIcon = SECTION_ICONS[kind];
  if (kindDesc && kindColor && kindIcon) {
    lines.push(`\`[!!info|${kindDesc} — not scoped to a project|${kindColor}]\``);
  }
  lines.push('');
  lines.push(...buildDataviewTable(`general/${KIND_DIR_MAP[kind] || `${kind}s`}`, kind, header));
  lines.push('');
  lines.push('---');
  lines.push(`Last rebuilt: ${formatDateTime()}`);

  return lines.join('\n');
}
