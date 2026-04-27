// obsidian.ts - Obsidian detection, vault registry, and launch utilities
// Isolates OS interaction from the pure handler functions in tool-handlers.ts.
// This is the first OS interaction (process spawn) from the MCP layer.

import * as fs from 'fs';
import * as path from 'path';
import { logToFile } from './logger.js';
import { contractPath } from './utils/path.js';

// ---- Types ----

export interface ObsidianDetection {
  installed: boolean;
  binaryPath?: string;
}

// ---- Platform detection ----

function detectMacOS(): ObsidianDetection {
  const appPath = '/Applications/Obsidian.app';
  if (fs.existsSync(appPath)) {
    return { installed: true, binaryPath: `${appPath}/Contents/MacOS/Obsidian` };
  }
  return { installed: false };
}

function detectLinux(): ObsidianDetection {
  const candidates = [
    '/usr/bin/obsidian',
    '/snap/bin/obsidian',
    path.join(process.env.HOME || '', '.local/bin/obsidian'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      return { installed: true, binaryPath: p };
    }
  }
  return { installed: false };
}

function detectWindows(): ObsidianDetection {
  const localAppData = process.env.LOCALAPPDATA || '';
  if (localAppData) {
    const exePath = path.join(localAppData, 'Obsidian', 'Obsidian.exe');
    if (fs.existsSync(exePath)) {
      return { installed: true, binaryPath: exePath };
    }
  }
  return { installed: false };
}

/** Detect whether Obsidian is installed on this system. */
export function detectObsidian(platform?: string): ObsidianDetection {
  const plat = platform || process.platform;
  switch (plat) {
    case 'darwin': return detectMacOS();
    case 'linux': return detectLinux();
    case 'win32': return detectWindows();
    default: return { installed: false };
  }
}

// ---- Vault registry ----

/** Platform-specific path to Obsidian's vault registry (obsidian.json). */
export function getRegistryPath(platform?: string): string | null {
  const plat = platform || process.platform;
  const home = process.env.HOME || '';
  switch (plat) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
    case 'linux':
      return path.join(home, '.config', 'obsidian', 'obsidian.json');
    case 'win32': {
      const appData = process.env.APPDATA || '';
      return appData ? path.join(appData, 'obsidian', 'obsidian.json') : null;
    }
    default:
      return null;
  }
}

/** Check if a vault path is already registered in Obsidian's vault list. */
export function isVaultRegistered(vaultPath: string, platform?: string): boolean {
  const registryPath = getRegistryPath(platform);
  if (!registryPath || !fs.existsSync(registryPath)) return false;

  try {
    const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    const vaults = data?.vaults;
    if (!vaults || typeof vaults !== 'object') return false;

    // Normalize paths for comparison
    let normalizedVault: string;
    try {
      normalizedVault = fs.realpathSync(vaultPath);
    } catch {
      normalizedVault = path.resolve(vaultPath);
    }

    for (const entry of Object.values(vaults)) {
      const entryPath = (entry as { path?: string })?.path;
      if (!entryPath) continue;
      try {
        if (fs.realpathSync(entryPath) === normalizedVault) return true;
      } catch {
        if (path.resolve(entryPath) === normalizedVault) return true;
      }
    }
    return false;
  } catch (error) {
    logToFile('DEBUG', 'Failed to read Obsidian vault registry', {
      registryPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ---- Launch ----

/** Open a URI using the platform's default handler (open/xdg-open/start). */
function openUri(uri: string, platform?: string): void {
  const plat = platform || process.platform;

  let cmd: string;
  let args: string[];
  switch (plat) {
    case 'darwin':
      cmd = 'open';
      args = [uri];
      break;
    case 'win32':
      cmd = 'cmd';
      args = ['/c', 'start', '', uri];
      break;
    default: // linux and others
      cmd = 'xdg-open';
      args = [uri];
      break;
  }

  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.unref();
  } catch (error) {
    logToFile('WARN', 'Failed to open URI', {
      uri, error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Launch Obsidian: URI scheme (vault=) if registered, binary spawn otherwise. */
export function launchObsidian(
  detection: ObsidianDetection,
  vaultPath: string,
  filePath?: string,
  platform?: string,
): void {
  const plat = platform || process.platform;
  const vaultName = path.basename(vaultPath);
  const registered = isVaultRegistered(vaultPath, plat);

  if (registered) {
    // vault= opens by name; file= navigates within it (path= is for files only, not directories)
    let uri: string;
    if (filePath) {
      uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
    } else {
      uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}`;
    }
    logToFile('DEBUG', 'Launching Obsidian via URI scheme', { uri });
    openUri(uri, plat);
  } else if (detection.binaryPath) {
    logToFile('DEBUG', 'Launching Obsidian binary', {
      binary: detection.binaryPath,
      vault: vaultPath,
    });
    try {
      // macOS: `open -a Obsidian /path` reliably opens directory as vault
      // Other platforms: spawn binary directly
      if (plat === 'darwin') {
        const proc = Bun.spawn(['open', '-a', 'Obsidian', vaultPath], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        proc.unref();
      } else {
        const proc = Bun.spawn([detection.binaryPath, vaultPath], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        proc.unref();
      }
    } catch (error) {
      logToFile('WARN', 'Failed to spawn Obsidian', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Best-effort: navigate to file after vault has time to register
    if (filePath) {
      const fileUri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
      setTimeout(() => openUri(fileUri, plat), 2000);
    }
  }
}

// ---- Message formatting ----

export function formatNotInstalledMessage(vaultPath: string): string {
  const displayPath = contractPath(vaultPath);
  return `Obsidian is not installed on this system.

To browse your knowledge base visually:
1. Download Obsidian from https://obsidian.md/download
2. Open Obsidian and select "Open folder as vault"
3. Point it to: ${displayPath}

Your vault is already Obsidian-compatible — wikilinks, frontmatter, and markdown all work out of the box.`;
}

export function formatSuccessMessage(vaultPath: string, project?: string): string {
  const displayPath = contractPath(vaultPath);
  let msg = `Opened vault in Obsidian (${displayPath})`;
  if (project) {
    msg += `\nFocused on project: ${project}`;
  }
  return msg;
}
