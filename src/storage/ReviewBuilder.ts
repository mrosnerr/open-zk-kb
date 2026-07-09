// ReviewBuilder.ts - Deterministic review queue generation for fleeting notes
// Pure markdown rendering. No LLM, no judgment.

import type { NoteMetadata } from './NoteRepository.js';
import { extractProjectFromTags, KIND_DIR_MAP } from './path-resolver.js';

function formatDateTime(date: Date = new Date()): string {
  return date.toISOString().replace('T', ' ').substring(0, 16);
}

function getReviewDataviewSource(note: NoteMetadata, project: string | null): string {
  if (note.kind === 'personalization') {
    return KIND_DIR_MAP.personalization;
  }

  const kindDir = KIND_DIR_MAP[note.kind] || `${note.kind}s`;
  return project ? `projects/${project}/${kindDir}` : `general/${kindDir}`;
}

function buildReviewDataviewTable(notes: NoteMetadata[]): string[] {
  const paths = notes.map(n => {
    const dir = extractProjectFromTags(n.tags);
    if (!dir) return null;
    return getReviewDataviewSource(n, dir);
  }).filter(Boolean);
 
   const uniqueDirs = [...new Set(paths)];
   if (uniqueDirs.length === 0) return [];
 
   const ids = new Set(notes.map(n => n.id));
   const idArray = JSON.stringify([...ids]);
 
   return [
     '```dataviewjs',
     `const ids = new Set(${idArray});`,
     `const pages = dv.pages('${uniqueDirs.map(d => `"${d}"`).join(' or ')}')`,
      '  .where(p => ids.has(String(p.id)) && p.status === "fleeting")',
     '  .sort(p => p.created, "asc");',
     'dv.table(["Note", "Tagline", "Kind", "Age", " "], pages.map(p => {',
     '  const created = p.created ? new Date(p.created) : new Date();',
     '  const days = Math.floor((Date.now() - created.getTime()) / 86400000);',
     '  const age = days === 0 ? "today" : days === 1 ? "1 day" : days + " days";',
     '  const actions = dv.el("span", "", { cls: "dataview-actions" });',
      '  const promBtn = actions.createEl("a", { cls: "dv-action-btn", attr: { "aria-label": "Promote", title: "Promote to permanent" } });',
      '  obsidian.setIcon(promBtn, "check-circle");',
      '  promBtn.addEventListener("click", async (e) => {',
      '    e.preventDefault();',
      '    const file = app.vault.getAbstractFileByPath(p.file.path);',
      '    if (!file) { new Notice("File not found"); return; }',
      '    const confirmed = confirm(`Promote "${p.title || p.file.name}" to permanent?`);',
      '    if (confirmed) { await app.fileManager.processFrontMatter(file, (fm) => { fm.status = "permanent"; }); const row = promBtn.closest("tr"); if (row) row.remove(); new Notice("Promoted: " + (p.title || p.file.name)); }',
      '  });',
     '  const editBtn = actions.createEl("a", { cls: "dv-action-btn", attr: { "aria-label": "Edit", title: "Edit this note" } });',
     '  obsidian.setIcon(editBtn, "pencil");',
     '  editBtn.addEventListener("click", async (e) => {',
     '    e.preventDefault();',
     '    const confirmed = confirm(`Edit "${p.title || p.file.name}"?\\n\\nChanges to notes affect AI assistant behavior. Edits to title, summary, and guidance fields are used by agents across sessions.`);',
      '    if (confirmed) { const rov = app.plugins.plugins["read-only-view"]; if (rov?.settings) rov.settings.excludeRules.push(p.file.path); const f = app.vault.getAbstractFileByPath(p.file.path); if (f) { const leaf = app.workspace.getLeaf("tab"); await leaf.openFile(f, { state: { mode: "source", source: true } }); } }',
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
     '  return [dv.fileLink(p.file.path, false, label), p.tagline || "", p.kind || "", age, actions];',
     '}));',
     '```',
   ];
 }

function buildUnscopedDataviewTable(notes: NoteMetadata[]): string[] {
   const paths = notes.map(n => getReviewDataviewSource(n, null));
   const uniqueDirs = [...new Set(paths)];
   if (uniqueDirs.length === 0) return [];
 
   const ids = new Set(notes.map(n => n.id));
   const idArray = JSON.stringify([...ids]);
 
   return [
     '```dataviewjs',
     `const ids = new Set(${idArray});`,
     `const pages = dv.pages('${uniqueDirs.map(d => `"${d}"`).join(' or ')}')`,
      '  .where(p => ids.has(String(p.id)) && p.status === "fleeting")',
     '  .sort(p => p.created, "asc");',
     'dv.table(["Note", "Tagline", "Kind", "Age", " "], pages.map(p => {',
     '  const created = p.created ? new Date(p.created) : new Date();',
     '  const days = Math.floor((Date.now() - created.getTime()) / 86400000);',
     '  const age = days === 0 ? "today" : days === 1 ? "1 day" : days + " days";',
     '  const actions = dv.el("span", "", { cls: "dataview-actions" });',
      '  const promBtn = actions.createEl("a", { cls: "dv-action-btn", attr: { "aria-label": "Promote", title: "Promote to permanent" } });',
      '  obsidian.setIcon(promBtn, "check-circle");',
      '  promBtn.addEventListener("click", async (e) => {',
      '    e.preventDefault();',
      '    const file = app.vault.getAbstractFileByPath(p.file.path);',
      '    if (!file) { new Notice("File not found"); return; }',
      '    const confirmed = confirm(`Promote "${p.title || p.file.name}" to permanent?`);',
      '    if (confirmed) { await app.fileManager.processFrontMatter(file, (fm) => { fm.status = "permanent"; }); const row = promBtn.closest("tr"); if (row) row.remove(); new Notice("Promoted: " + (p.title || p.file.name)); }',
      '  });',
     '  const editBtn = actions.createEl("a", { cls: "dv-action-btn", attr: { "aria-label": "Edit", title: "Edit this note" } });',
     '  obsidian.setIcon(editBtn, "pencil");',
     '  editBtn.addEventListener("click", async (e) => {',
     '    e.preventDefault();',
     '    const confirmed = confirm(`Edit "${p.title || p.file.name}"?\\n\\nChanges to notes affect AI assistant behavior. Edits to title, summary, and guidance fields are used by agents across sessions.`);',
      '    if (confirmed) { const rov = app.plugins.plugins["read-only-view"]; if (rov?.settings) rov.settings.excludeRules.push(p.file.path); const f = app.vault.getAbstractFileByPath(p.file.path); if (f) { const leaf = app.workspace.getLeaf("tab"); await leaf.openFile(f, { state: { mode: "source", source: true } }); } }',
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
     '  return [dv.fileLink(p.file.path, false, label), p.tagline || "", p.kind || "", age, actions];',
     '}));',
     '```',
   ];
 }

export function buildReviewContent(fleetingNotes: NoteMetadata[]): string {
  const lines: string[] = [];

  lines.push('---');
  lines.push('cssclasses:');
  lines.push('  - folder-note-shell');
  lines.push('up: "[[Home|Home]]"');
  lines.push('---');
  lines.push('');
  lines.push(`# \`[!!clipboard-check]\` Needs Review (${fleetingNotes.length})`);
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

    if (project === '_unscoped') {
      lines.push(`## \`[!!inbox]\` Unscoped (${notes.length})`);
      lines.push('');
      lines.push(...buildUnscopedDataviewTable(notes));
    } else {
      lines.push(`## \`[!!folder-open]\` ${project} (${notes.length})`);
      lines.push('');
      lines.push(...buildReviewDataviewTable(notes));
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`Last rebuilt: ${formatDateTime()}`);

  return lines.join('\n');
}
