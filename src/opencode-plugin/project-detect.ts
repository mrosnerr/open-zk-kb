import * as path from 'path';

/**
 * Derive a project tag from a working directory path.
 *
 * Heuristic: the deepest directory component under ~/dev/ becomes
 * the project name. For paths outside ~/dev/, falls back to the
 * basename of the directory itself.
 *
 * Returns null if the directory is a home directory or root.
 */
export function detectProject(directory: string): string | null {
  const home = process.env.HOME || '';
  if (!home || directory === home || directory === '/') return null;

  const devDir = path.join(home, 'dev');
  if (directory.startsWith(devDir + '/')) {
    const relative = directory.slice(devDir.length + 1);
    const topLevel = relative.split('/')[0];
    if (topLevel) return topLevel;
  }

  const basename = path.basename(directory);
  return basename || null;
}
