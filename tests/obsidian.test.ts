import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  detectObsidian,
  getRegistryPath,
  isVaultRegistered,
  formatNotInstalledMessage,
  formatSuccessMessage,
} from '../src/obsidian.js';
import { handleOpen } from '../src/tool-handlers.js';
import { handleStore } from '../src/tool-handlers.js';
import { createTestHarness, cleanupTestHarness } from './harness.js';
import type { TestContext } from './harness.js';

describe('Obsidian Detection', () => {
  it('should return installed=false for unknown platforms', () => {
    const result = detectObsidian('freebsd');
    expect(result.installed).toBe(false);
    expect(result.binaryPath).toBeUndefined();
  });

  it('should detect macOS Obsidian when app exists', () => {
    const result = detectObsidian('darwin');
    if (fs.existsSync('/Applications/Obsidian.app')) {
      expect(result.installed).toBe(true);
      expect(result.binaryPath).toBe('/Applications/Obsidian.app/Contents/MacOS/Obsidian');
    } else {
      expect(result.installed).toBe(false);
    }
  });

  it('should use platform parameter over process.platform', () => {
    const result = detectObsidian('win32');
    if (!process.env.LOCALAPPDATA || !fs.existsSync(path.join(process.env.LOCALAPPDATA, 'Obsidian', 'Obsidian.exe'))) {
      expect(result.installed).toBe(false);
    }
  });
});

describe('Vault Registry', () => {
  it('should return correct registry path per platform', () => {
    const macPath = getRegistryPath('darwin');
    expect(macPath).toContain('Library/Application Support/obsidian/obsidian.json');

    const linuxPath = getRegistryPath('linux');
    expect(linuxPath).toContain('.config/obsidian/obsidian.json');

    const unknownPath = getRegistryPath('freebsd');
    expect(unknownPath).toBeNull();
  });

  it('should return null for win32 without APPDATA', () => {
    const origAppData = process.env.APPDATA;
    delete process.env.APPDATA;
    const result = getRegistryPath('win32');
    if (origAppData) process.env.APPDATA = origAppData;
    expect(result).toBeNull();
  });

  it('should return false when registry file does not exist', () => {
    const result = isVaultRegistered('/nonexistent/vault', 'freebsd');
    expect(result).toBe(false);
  });

  it('should detect registered vault from obsidian.json', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-reg-'));
    const vaultDir = path.join(tempDir, 'test-vault');
    fs.mkdirSync(vaultDir);

    const configDir = path.join(tempDir, '.config', 'obsidian');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'obsidian.json'), JSON.stringify({
      vaults: {
        'abc123': { path: vaultDir, ts: Date.now() },
      },
    }));

    const origHome = process.env.HOME;
    process.env.HOME = tempDir;

    try {
      const registered = isVaultRegistered(vaultDir, 'linux');
      expect(registered).toBe(true);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should return false for unregistered vault', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-unreg-'));
    const vaultDir = path.join(tempDir, 'my-vault');
    fs.mkdirSync(vaultDir);

    const configDir = path.join(tempDir, '.config', 'obsidian');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'obsidian.json'), JSON.stringify({
      vaults: {
        'xyz789': { path: '/some/other/vault' },
      },
    }));

    const origHome = process.env.HOME;
    process.env.HOME = tempDir;

    try {
      const result = isVaultRegistered(vaultDir, 'linux');
      expect(result).toBe(false);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should handle malformed registry gracefully', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-bad-'));
    const configDir = path.join(tempDir, '.config', 'obsidian');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'obsidian.json'), 'not valid json');

    const origHome = process.env.HOME;
    process.env.HOME = tempDir;

    try {
      const result = isVaultRegistered('/any/vault', 'linux');
      expect(result).toBe(false);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should handle registry with no vaults key', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-novaults-'));
    const configDir = path.join(tempDir, '.config', 'obsidian');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'obsidian.json'), JSON.stringify({ version: '1.0' }));

    const origHome = process.env.HOME;
    process.env.HOME = tempDir;

    try {
      const result = isVaultRegistered('/any/vault', 'linux');
      expect(result).toBe(false);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should return null for macOS registry when HOME is empty', () => {
    const origHome = process.env.HOME;
    process.env.HOME = '';
    const result = getRegistryPath('darwin');
    process.env.HOME = origHome;
    expect(result).toBeNull();
  });

  it('should return null for linux registry when HOME is empty', () => {
    const origHome = process.env.HOME;
    process.env.HOME = '';
    const result = getRegistryPath('linux');
    process.env.HOME = origHome;
    expect(result).toBeNull();
  });
});

describe('Message Formatting', () => {
  it('should format not-installed message with vault path', () => {
    const msg = formatNotInstalledMessage('/home/user/.local/share/open-zk-kb');
    expect(msg).toContain('Obsidian is not installed');
    expect(msg).toContain('https://obsidian.md/download');
    expect(msg).toContain('Open folder as vault');
    expect(msg).toContain('wikilinks, frontmatter, and markdown');
  });

  it('should contract home path in not-installed message', () => {
    const home = process.env.HOME || os.homedir();
    const msg = formatNotInstalledMessage(path.join(home, '.local/share/open-zk-kb'));
    expect(msg).toContain('~/.local/share/open-zk-kb');
  });

  it('should format success message without project', () => {
    const msg = formatSuccessMessage('/home/user/.local/share/open-zk-kb');
    expect(msg).toContain('Opened vault in Obsidian');
    expect(msg).not.toContain('Focused on project');
  });

  it('should format success message with project', () => {
    const msg = formatSuccessMessage('/home/user/.local/share/open-zk-kb', 'conductor');
    expect(msg).toContain('Opened vault in Obsidian');
    expect(msg).toContain('Focused on project: conductor');
  });
});

describe('handleOpen', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should return error when vault does not exist', () => {
    const config = { ...ctx.config, vault: '/nonexistent/vault/path' };
    const result = handleOpen({}, config);
    expect(result).toContain('Vault directory does not exist');
    expect(result).toContain('Store a note first');
  });

  it('should return not-installed message when Obsidian is missing', () => {
    const result = handleOpen({}, ctx.config);

    if (!detectObsidian().installed) {
      expect(result).toContain('Obsidian is not installed');
      expect(result).toContain('https://obsidian.md/download');
    } else {
      expect(result).toContain('Opened vault in Obsidian');
    }
  });

  it('should handle project parameter with index note', () => {
    handleStore({
      title: 'Test Note',
      content: 'Test content for project',
      kind: 'reference',
      summary: 'A test note',
      guidance: 'Test guidance',
      project: 'myapp',
    }, ctx.engine, null, ctx.config);

    const result = handleOpen({ project: 'myapp' }, ctx.config, ctx.engine);

    if (detectObsidian().installed) {
      expect(result).toContain('Focused on project: myapp');
    } else {
      expect(result).toContain('Obsidian is not installed');
    }
  });

  it('should not claim project focus when no index note exists', () => {
    const result = handleOpen({ project: 'nonexistent' }, ctx.config, ctx.engine);

    if (!detectObsidian().installed) {
      expect(result).toContain('Obsidian is not installed');
    } else {
      expect(result).not.toContain('Focused on project');
    }
  });

  it('should work without repo when no project specified', () => {
    const result = handleOpen({}, ctx.config);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
