// path-resolver.ts - Deterministic path resolution for vault directory layout
// Pure functions: kind + project + id + slug → absolute file path
// Implements birthplace-only placement rules from #91

import * as fs from 'fs';
import * as path from 'path';
import type { NoteKind } from '../types.js';

/** Singleton kinds get fixed filenames (no ID prefix) */
const SINGLETON_KINDS = new Set<NoteKind>(['domain', 'index', 'log']);

/** Maps kind → plural directory name */
const KIND_DIR_MAP: Record<string, string> = {
  decision: 'decisions',
  reference: 'references',
  procedure: 'procedures',
  observation: 'observations',
  resource: 'resources',
};

const GLOBAL_HOME_NOTE_BASENAME = 'Home';

function folderNoteBasename(folderName: string): string {
  return folderName;
}

export function getGlobalHomeNoteBasename(): string {
  return GLOBAL_HOME_NOTE_BASENAME;
}

export function getGlobalHomeNotePath(docsPath: string): string {
  return path.join(docsPath, `${GLOBAL_HOME_NOTE_BASENAME}.md`);
}

export function getProjectFolderNoteBasename(project: string): string {
  return folderNoteBasename(sanitizeProjectSegment(project));
}

export function getProjectFolderNotePath(docsPath: string, project: string): string {
  const safeProject = sanitizeProjectSegment(project);
  return path.join(docsPath, 'projects', safeProject, `${folderNoteBasename(safeProject)}.md`);
}

export function getProjectsFolderNoteBasename(): string {
  return folderNoteBasename('projects');
}

export function getProjectsFolderNotePath(docsPath: string): string {
  return path.join(docsPath, 'projects', `${getProjectsFolderNoteBasename()}.md`);
}

export function getGeneralFolderNoteBasename(): string {
  return folderNoteBasename('general');
}

export function getGeneralFolderNotePath(docsPath: string): string {
  return path.join(docsPath, 'general', `${getGeneralFolderNoteBasename()}.md`);
}

export function getPreferencesFolderNoteBasename(): string {
  return folderNoteBasename('preferences');
}

export function getPreferencesFolderNotePath(docsPath: string): string {
  return path.join(docsPath, 'preferences', `${getPreferencesFolderNoteBasename()}.md`);
}

export function getKindFolderNoteBasename(kindOrDir: string): string {
  return folderNoteBasename(KIND_DIR_MAP[kindOrDir] || kindOrDir);
}

export function getKindFolderNotePath(baseDir: string, kindOrDir: string): string {
  const basename = getKindFolderNoteBasename(kindOrDir);
  return path.join(baseDir, `${basename}.md`);
}

/** Directories to skip during recursive file scanning */
const SKIP_DIRS = new Set(['.index', '.obsidian', '.trash', 'templates', '.templates', '.git', 'node_modules']);

function sanitizeProjectSegment(project: string): string {
  const trimmed = project.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[/\\]/.test(trimmed)) {
    throw new Error(`Invalid project name: "${project}"`);
  }
  return trimmed;
}

/**
 * Resolve the absolute file path for a note based on placement rules.
 *
 * Placement rules:
 *   personalization        → preferences/{id}-{slug}.md
 *   domain  + project      → projects/{project}/domain.md
 *   index   + project      → projects/{project}/{project}.md
 *   log     + project      → projects/{project}/log.md
 *   {kind}  + project      → projects/{project}/{kinds}/{id}-{slug}.md
 *   {kind}  - no project   → general/{kinds}/{id}-{slug}.md
 *   index/log - no project → {vault}/Home.md or log.md (global structural)
 */
export function resolveNotePath(
  docsPath: string,
  kind: NoteKind,
  project: string | null,
  id: string,
  slug: string,
): string {
  // Personalization always goes to preferences/, regardless of project
  if (kind === 'personalization') {
    return path.join(docsPath, 'preferences', `${id}-${slug}.md`);
  }

  const safeProject = project ? sanitizeProjectSegment(project) : null;

  // Singleton kinds: fixed filename, no ID prefix
  if (SINGLETON_KINDS.has(kind)) {
    if (safeProject) {
      if (kind === 'index') return getProjectFolderNotePath(docsPath, safeProject);
      return path.join(docsPath, 'projects', safeProject, `${kind}.md`);
    }
    // Global structural note (no project) — lives at vault root
    if (kind === 'index') return getGlobalHomeNotePath(docsPath);
    return path.join(docsPath, `${kind}.md`);
  }

  // Regular kinds: {id}-{slug}.md in kind directory
  const dirName = KIND_DIR_MAP[kind] || `${kind}s`;

  if (safeProject) {
    return path.join(docsPath, 'projects', safeProject, dirName, `${id}-${slug}.md`);
  }

  // No project → general/
  return path.join(docsPath, 'general', dirName, `${id}-${slug}.md`);
}

export function extractProjectFromTags(tags: string[]): string | null {
  for (const tag of tags) {
    if (tag.startsWith('project:')) {
      const val = tag.slice(8);
      const trimmed = val?.trim();
      return trimmed && !trimmed.includes('/') && !trimmed.includes('\\') && trimmed !== '..' && trimmed !== '.' ? trimmed : null;
    }
  }
  return null;
}

/**
 * Recursively collect all .md files from a directory tree.
 * Skips .index/, .obsidian/, templates/, .git/, node_modules/.
 */
export function walkMarkdownFiles(dirPath: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return; // Directory doesn't exist or not readable
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);

      // Skip known non-note directories
      if (SKIP_DIRS.has(entry)) continue;

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue; // Broken symlink or permission issue
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith('.md')) {
        results.push(fullPath);
      }
    }
  }

  walk(dirPath);
  return results;
}

export { SINGLETON_KINDS, KIND_DIR_MAP, SKIP_DIRS };
