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
  const home = process.env.HOME || '';
  const candidates = [
    '/Applications/Obsidian.app',
    ...(home ? [path.join(home, 'Applications/Obsidian.app')] : []),
  ];
  for (const appPath of candidates) {
    if (fs.existsSync(appPath)) {
      return { installed: true, binaryPath: `${appPath}/Contents/MacOS/Obsidian` };
    }
  }
  return { installed: false };
}

function detectLinux(): ObsidianDetection {
  const home = process.env.HOME || '';
  const candidates = [
    '/usr/bin/obsidian',
    '/snap/bin/obsidian',
    ...(home ? [path.join(home, '.local/bin/obsidian')] : []),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
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
      return home ? path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json') : null;
    case 'linux':
      return home ? path.join(home, '.config', 'obsidian', 'obsidian.json') : null;
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

/** Register a vault in Obsidian's obsidian.json so URI scheme works. */
export function registerVault(vaultPath: string, platform?: string): boolean {
  const registryPath = getRegistryPath(platform);
  if (!registryPath) return false;

  try {
    // Obsidian requires .obsidian/ to recognize a directory as a vault
    const obsidianDir = path.join(vaultPath, '.obsidian');
    if (!fs.existsSync(obsidianDir)) {
      fs.mkdirSync(obsidianDir, { recursive: true });
    }

    let data: Record<string, unknown>;
    if (fs.existsSync(registryPath)) {
      data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      if (!data.vaults || typeof data.vaults !== 'object') {
        data.vaults = {};
      }
    } else {
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      data = { vaults: {} };
    }

    const vaults = data.vaults as Record<string, { path: string; ts: number }>;
    const resolvedPath = path.resolve(vaultPath);
    const alreadyRegistered = Object.values(vaults).some(v => v.path === resolvedPath);
    if (alreadyRegistered) return true;

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    vaults[id] = { path: resolvedPath, ts: Date.now() };
    const tmpPath = registryPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, registryPath);
    logToFile('INFO', 'Registered vault in Obsidian', { vaultPath, registryPath });
    return true;
  } catch (error) {
    logToFile('WARN', 'Failed to register vault in Obsidian', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ---- Launch ----

/** Open a URI using the platform's default handler. Returns error message or null. */
function openUri(uri: string, platform?: string): string | null {
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
      args = ['/c', 'start', '', `"${uri}"`];
      break;
    default: // linux and others
      cmd = 'xdg-open';
      args = [uri];
      break;
  }

  try {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5000);
    const proc = Bun.spawn([cmd, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
      signal: abort.signal,
      onExit: () => clearTimeout(timeout),
    });
    proc.unref();
    return null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logToFile('WARN', 'Failed to open URI', { uri, error: msg });
    return msg;
  }
}

/** Launch Obsidian: URI scheme (vault=) if registered, binary spawn otherwise. Returns error or null. */
export function launchObsidian(
  detection: ObsidianDetection,
  vaultPath: string,
  filePath?: string,
  platform?: string,
): string | null {
  const plat = platform || process.platform;
  const vaultName = path.basename(vaultPath);
  const registered = isVaultRegistered(vaultPath, plat);

  if (!registered) {
    if (!registerVault(vaultPath, plat)) {
      return 'Failed to register vault in Obsidian — check vault path and permissions';
    }
  }

  // vault= opens by name; file= navigates within it (path= is for files only, not directories)
  let uri: string;
  if (filePath) {
    uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
  } else {
    uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}`;
  }
  logToFile('DEBUG', 'Launching Obsidian via URI scheme', { uri });
  return openUri(uri, plat);
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
