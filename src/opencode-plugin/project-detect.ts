import * as path from 'path';

/**
 * Derive a project tag from a working directory path.
 *
 * Heuristic: the top-level directory component under ~/dev/ becomes
 * the project name. For paths outside ~/dev/, falls back to the
 * basename of the directory itself.
 *
 * Returns null if the directory is a home directory, ~/dev itself, or root.
 */
export function detectProject(directory: string): string | null {
  const home = process.env.HOME || '';
  if (!home) return null;

  const normalized = path.resolve(directory);
  const normalizedHome = path.resolve(home);

  if (normalized === normalizedHome || normalized === '/') return null;

  const devDir = path.join(normalizedHome, 'dev');
  if (normalized === devDir) return null;

  if (normalized.startsWith(devDir + '/')) {
    const relative = normalized.slice(devDir.length + 1);
    const topLevel = relative.split('/')[0];
    if (topLevel) return topLevel;
  }

  const basename = path.basename(normalized);
  return basename || null;
}
