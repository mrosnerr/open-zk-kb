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
  personalization: 'preferences',
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

/**
 * True for generated structural Markdown that legitimately carries no note
 * identifier: `kind: index` frontmatter, the fixed `index`/`log`/`review`
 * files, the global home note, and marked generated directory folder notes.
 * Every consumer of the vault's canonical Markdown inventory must exclude
 * exactly this set, so an unindexed authored note is never mistaken for
 * scaffolding merely because its basename matches its directory.
 */
export function isGeneratedStructuralMarkdown(
  docsPath: string,
  filePath: string,
  frontmatter: Record<string, unknown> = {},
): boolean {
  if (frontmatter.kind === 'index') return true;

  const relative = path.relative(docsPath, filePath).replace(/\\/g, '/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) return false;
  const segments = relative.split('/');
  const basename = path.basename(filePath, '.md');

  if (segments.length === 1) {
    return basename === GLOBAL_HOME_NOTE_BASENAME || /^(index|log|review)$/i.test(basename);
  }
  if (segments.length === 3 && segments[0] === 'projects' && segments[2].toLowerCase() === 'log.md') return true;

  // Legacy navigation scaffolds recognized by the navigation migration paths.
  if (basename.toLowerCase() === 'index') {
    if (relative === 'general/index.md' || relative === 'preferences/index.md') return true;
    if (segments[0] === 'general' && segments.length === 3) return true;
    if (segments[0] === 'projects' && (segments.length === 3 || segments.length === 4)) return true;
  }

  return basename === path.basename(path.dirname(filePath)) && frontmatter['BC-folder-note'] === true;
}

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

export interface WalkMarkdownFilesOptions {
  /** Called when a filesystem failure prevents traversal from being complete. */
  onError?: (error: unknown, filePath: string) => void;
}

/**
 * Recursively collect all .md files from a directory tree.
 * Skips .index/, .obsidian/, templates/, .git/, node_modules/.
 */
export function walkMarkdownFiles(dirPath: string, options: WalkMarkdownFilesOptions = {}): string[] {
  const results: string[] = [];

  const activeDirectoryIdentities = new Set<string>();

  function walk(dir: string): void {
    // statSync follows directory symlinks, so guard ancestor identities to avoid
    // recursively following a link back into the directory currently being walked.
    let directoryIdentity: string;
    try {
      directoryIdentity = fs.realpathSync(dir);
    } catch (error) {
      options.onError?.(error, dir);
      return;
    }
    if (activeDirectoryIdentities.has(directoryIdentity)) return;
    activeDirectoryIdentities.add(directoryIdentity);

    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch (error) {
      activeDirectoryIdentities.delete(directoryIdentity);
      options.onError?.(error, dir);
      return; // Directory doesn't exist or not readable
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);

      // Skip known non-note directories
      if (SKIP_DIRS.has(entry)) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch (error) {
        options.onError?.(error, fullPath);
        continue; // Broken symlink or permission issue
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith('.md')) {
        results.push(fullPath);
      }
    }

    activeDirectoryIdentities.delete(directoryIdentity);
  }

  walk(dirPath);
  return results;
}

export { SINGLETON_KINDS, KIND_DIR_MAP, SKIP_DIRS };
