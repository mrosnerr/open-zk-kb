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

/** Directories to skip during recursive file scanning */
const SKIP_DIRS = new Set(['.index', '.obsidian', 'templates', '.git', 'node_modules']);

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
 *   index   + project      → projects/{project}/index.md
 *   log     + project      → projects/{project}/log.md
 *   {kind}  + project      → projects/{project}/{kinds}/{id}-{slug}.md
 *   {kind}  - no project   → general/{kinds}/{id}-{slug}.md
 *   index/log - no project → {vault}/index.md or log.md (global structural)
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
      return path.join(docsPath, 'projects', safeProject, `${kind}.md`);
    }
    // Global structural note (no project) — lives at vault root
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
