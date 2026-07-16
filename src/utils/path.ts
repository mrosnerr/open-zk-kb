// utils/path.ts - Centralized path expansion utility
import * as os from 'os';
import * as path from 'path';

/**
 * Expand a path that may contain ~ to the user's home directory
 * Also handles relative paths by resolving them to absolute
 */
export function expandPath(inputPath: string | unknown): string {
  if (typeof inputPath !== 'string' || !inputPath) {
    throw new Error(`expandPath: invalid input path (got ${typeof inputPath}: ${JSON.stringify(inputPath)}). Expected non-empty string.`);
  }
  
  // Expand ~ to home directory
  // Check process.env.HOME first to support test isolation (os.homedir() is cached)
  if (inputPath.startsWith('~')) {
    const home = process.env.HOME || os.homedir();
    if (!home) {
      throw new Error(`expandPath: cannot expand '~' — neither $HOME nor os.homedir() are set`);
    }
    return path.join(home, inputPath.slice(1));
  }
  
  // If already absolute, return as-is
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }
  
  // Relative path - resolve to absolute
  return path.resolve(inputPath);
}

/**
 * Contract an absolute path back to ~ format for display
 */
export function contractPath(absolutePath: string): string {
  if (!absolutePath) return '';
  
  // Check process.env.HOME first to support test isolation (os.homedir() is cached)
  const home = process.env.HOME || os.homedir() || '';
  if (home && absolutePath.startsWith(home)) {
    return '~' + absolutePath.slice(home.length);
  }
  
  return absolutePath;
}

export default { expandPath, contractPath };
