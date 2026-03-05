import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTestHarness, cleanupTestHarness } from './harness.js';
import type { TestContext } from './harness.js';

interface EnvSnapshot {
  XDG_CONFIG_HOME?: string;
  XDG_DATA_HOME?: string;
}

describe('setup.ts', () => {
  let ctx: TestContext;
  let envSnapshot: EnvSnapshot;
  const tempDirs: string[] = [];

  beforeEach(() => {
    ctx = createTestHarness();
    envSnapshot = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    };
  });

  afterEach(() => {
    cleanupTestHarness(ctx);

    if (envSnapshot.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = envSnapshot.XDG_CONFIG_HOME;
    if (envSnapshot.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = envSnapshot.XDG_DATA_HOME;

    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createIsolatedInstallEnv(): {
    rootDir: string;
    xdgConfigHome: string;
    xdgDataHome: string;
    fakeServerPath: string;
  } {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-test-'));
    const xdgConfigHome = path.join(rootDir, 'xdg-config');
    const xdgDataHome = path.join(rootDir, 'xdg-data');
    const fakeServerPath = path.join(rootDir, 'dist', 'mcp-server.js');

    fs.mkdirSync(path.dirname(fakeServerPath), { recursive: true });
    fs.writeFileSync(fakeServerPath, 'export {};\n', 'utf-8');
    fs.mkdirSync(xdgConfigHome, { recursive: true });
    fs.mkdirSync(xdgDataHome, { recursive: true });

    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    process.env.XDG_DATA_HOME = xdgDataHome;

    tempDirs.push(rootDir);

    return { rootDir, xdgConfigHome, xdgDataHome, fakeServerPath };
  }

  async function loadFreshSetupModule() {
    return import(`../src/setup.js?test=${Date.now()}-${Math.random()}`);
  }

  it('produces correct claude-code MCP JSON entry in dry-run mode', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const output = setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
      dryRun: true,
    });

    expect(output).toContain('Dry run: Would add to');
    expect(output).toContain('settings.json');
    expect(output).toContain('"type": "local"');
    expect(output).toContain('"command": [');
    expect(output).toContain('"bun"');
    expect(output).toContain(`"${env.fakeServerPath}"`);
    expect(output).toContain('"enabled": true');
  });

  it('creates config file with nested MCP entry when none exists', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'cursor',
      serverPath: env.fakeServerPath,
    });

    const configPath = path.join(env.xdgConfigHome, 'cursor', 'mcp.json');
    expect(fs.existsSync(configPath)).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      mcpServers?: {
        'open-zk-kb'?: {
          type?: string;
          command?: string[];
          enabled?: boolean;
        };
      };
    };

    expect(config.mcpServers?.['open-zk-kb']?.type).toBe('local');
    expect(config.mcpServers?.['open-zk-kb']?.command).toEqual(['bun', 'run', env.fakeServerPath]);
    expect(config.mcpServers?.['open-zk-kb']?.enabled).toBe(true);
  });

  it('is idempotent when install runs twice without force', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const first = setupModule.install({
      client: 'cursor',
      serverPath: env.fakeServerPath,
    });
    const second = setupModule.install({
      client: 'cursor',
      serverPath: env.fakeServerPath,
    });

    const configPath = path.join(env.xdgConfigHome, 'cursor', 'mcp.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };

    expect(first).toContain('Installed open-zk-kb for Cursor');
    expect(second).toContain('Already installed for Cursor');
    expect(Object.keys(config.mcpServers)).toEqual(['open-zk-kb']);
  });

  it('uninstall removes existing MCP entry from config', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'cursor',
      serverPath: env.fakeServerPath,
    });

    const uninstallOutput = setupModule.uninstall({
      client: 'cursor',
    });

    const configPath = path.join(env.xdgConfigHome, 'cursor', 'mcp.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      mcpServers?: Record<string, unknown>;
    };

    expect(uninstallOutput).toContain('Uninstalled open-zk-kb from Cursor');
    expect(config.mcpServers?.['open-zk-kb']).toBeUndefined();
  });

  it('creates vault directory and index directory on install', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'cursor',
      serverPath: env.fakeServerPath,
    });

    const vaultPath = path.join(env.xdgDataHome, 'open-zk-kb');
    expect(fs.existsSync(vaultPath)).toBe(true);
    expect(fs.existsSync(path.join(vaultPath, '.index'))).toBe(true);
  });
});
