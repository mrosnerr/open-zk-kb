// ReviewBuilder.ts - Deterministic review queue generation for fleeting notes
// Pure markdown rendering. No LLM, no judgment.

import type { NoteMetadata } from './NoteRepository.js';
import { extractProjectFromTags } from './path-resolver.js';

function formatDateTime(date: Date = new Date()): string {
  return date.toISOString().replace('T', ' ').substring(0, 16);
}

function buildReviewDataviewTable(notes: NoteMetadata[]): string[] {
   const paths = notes.map(n => {
     const dir = n.tags
       ?.find((t: string) => t.startsWith('project:'))
       ?.replace('project:', '');
     if (!dir) return null;
     const kindDir = `${n.kind}s`;
     return `projects/${dir}/${kindDir}`;
   }).filter(Boolean);
 
   const uniqueDirs = [...new Set(paths)];
   if (uniqueDirs.length === 0) return [];
 
   const ids = new Set(notes.map(n => n.id));
   const idArray = JSON.stringify([...ids]);
 
   return [
     '```dataviewjs',
     `const ids = new Set(${idArray});`,
     `const pages = dv.pages('${uniqueDirs.map(d => `"${d}"`).join(' or ')}')`,
     '  .where(p => ids.has(String(p.id)))',
     '  .sort(p => p.created, "asc");',
     'dv.table(["Note", "Summary", "Kind", "Age", " "], pages.map(p => {',
     '  const created = p.created ? new Date(p.created) : new Date();',
     '  const days = Math.floor((Date.now() - created.getTime()) / 86400000);',
     '  const age = days === 0 ? "today" : days === 1 ? "1 day" : days + " days";',
     '  const actions = dv.el("span", "", { cls: "dataview-actions" });',
     '  const promBtn = actions.createEl("a", { cls: "dv-action-btn", href: "obsidian://quickadd?choice=Promote%20Note&value-path=" + encodeURIComponent(p.file.path), attr: { "aria-label": "Promote", title: "Promote to permanent" } });',
     '  obsidian.setIcon(promBtn, "check-circle");',
     '  const editBtn = actions.createEl("a", { cls: "dv-action-btn", attr: { "aria-label": "Edit", title: "Edit this note" } });',
     '  obsidian.setIcon(editBtn, "pencil");',
     '  editBtn.addEventListener("click", (e) => {',
     '    e.preventDefault();',
     '    const confirmed = confirm(`Edit "${p.title || p.file.name}"?\\n\\nChanges to notes affect AI assistant behavior. Edits to title, summary, and guidance fields are used by agents across sessions.`);',
     '    if (confirmed) window.open("obsidian://quickadd?choice=Edit%20Note&value-path=" + encodeURIComponent(p.file.path));',
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
     '  return [dv.fileLink(p.file.path, false, label), p.summary || "", p.kind || "", age, actions];',
     '}));',
     '```',
   ];
 }

function buildUnscopedDataviewTable(notes: NoteMetadata[]): string[] {
   const paths = notes.map(n => `general/${n.kind}s`);
   const uniqueDirs = [...new Set(paths)];
   if (uniqueDirs.length === 0) return [];
 
   const ids = new Set(notes.map(n => n.id));
   const idArray = JSON.stringify([...ids]);
 
   return [
     '```dataviewjs',
     `const ids = new Set(${idArray});`,
     `const pages = dv.pages('${uniqueDirs.map(d => `"${d}"`).join(' or ')}')`,
     '  .where(p => ids.has(String(p.id)))',
     '  .sort(p => p.created, "asc");',
     'dv.table(["Note", "Summary", "Kind", "Age", " "], pages.map(p => {',
     '  const created = p.created ? new Date(p.created) : new Date();',
     '  const days = Math.floor((Date.now() - created.getTime()) / 86400000);',
     '  const age = days === 0 ? "today" : days === 1 ? "1 day" : days + " days";',
     '  const actions = dv.el("span", "", { cls: "dataview-actions" });',
     '  const promBtn = actions.createEl("a", { cls: "dv-action-btn", href: "obsidian://quickadd?choice=Promote%20Note&value-path=" + encodeURIComponent(p.file.path), attr: { "aria-label": "Promote", title: "Promote to permanent" } });',
     '  obsidian.setIcon(promBtn, "check-circle");',
     '  const editBtn = actions.createEl("a", { cls: "dv-action-btn", attr: { "aria-label": "Edit", title: "Edit this note" } });',
     '  obsidian.setIcon(editBtn, "pencil");',
     '  editBtn.addEventListener("click", (e) => {',
     '    e.preventDefault();',
     '    const confirmed = confirm(`Edit "${p.title || p.file.name}"?\\n\\nChanges to notes affect AI assistant behavior. Edits to title, summary, and guidance fields are used by agents across sessions.`);',
     '    if (confirmed) window.open("obsidian://quickadd?choice=Edit%20Note&value-path=" + encodeURIComponent(p.file.path));',
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
     '  return [dv.fileLink(p.file.path, false, label), p.summary || "", p.kind || "", age, actions];',
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
