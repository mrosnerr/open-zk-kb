import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTestHarness, cleanupTestHarness } from './harness.js';
import type { TestContext } from './harness.js';

interface EnvSnapshot {
  XDG_CONFIG_HOME?: string;
  XDG_DATA_HOME?: string;
  HOME?: string;
}

interface FileSnapshot {
  filePath: string;
  existed: boolean;
  content?: string;
}

type McpClient = 'opencode' | 'claude-code' | 'cursor' | 'windsurf' | 'zed';

interface ClientCase {
  client: McpClient;
  getConfigPath: (env: {
    xdgConfigHome: string;
    homeDir: string;
  }) => string;
  mcpPath: string[];
  format: 'opencode' | 'standard';
}

const CLIENT_CASES: ClientCase[] = [
  {
    client: 'opencode',
    getConfigPath: ({ xdgConfigHome }) => path.join(xdgConfigHome, 'opencode', 'opencode.json'),
    mcpPath: ['mcp', 'open-zk-kb'],
    format: 'opencode',
  },
  {
    client: 'claude-code',
    getConfigPath: ({ homeDir }) => path.join(homeDir, '.claude', 'settings.json'),
    mcpPath: ['mcpServers', 'open-zk-kb'],
    format: 'standard',
  },
  {
    client: 'cursor',
    getConfigPath: ({ homeDir }) => path.join(homeDir, '.cursor', 'mcp.json'),
    mcpPath: ['mcpServers', 'open-zk-kb'],
    format: 'standard',
  },
  {
    client: 'windsurf',
    getConfigPath: ({ homeDir }) => path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
    mcpPath: ['mcpServers', 'open-zk-kb'],
    format: 'standard',
  },
  {
    client: 'zed',
    getConfigPath: ({ xdgConfigHome }) => path.join(xdgConfigHome, 'zed', 'settings.json'),
    mcpPath: ['context_servers', 'open-zk-kb'],
    format: 'standard',
  },
];

function getNestedValue(obj: unknown, keys: string[]): unknown {
  let current: unknown = obj;

  for (const key of keys) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

describe('setup.ts', () => {
  let ctx: TestContext;
  let envSnapshot: EnvSnapshot;
  const tempDirs: string[] = [];
  const fileSnapshots: FileSnapshot[] = [];

  beforeEach(() => {
    ctx = createTestHarness();
    envSnapshot = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      HOME: process.env.HOME,
    };
  });

  afterEach(() => {
    cleanupTestHarness(ctx);

    if (envSnapshot.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = envSnapshot.XDG_CONFIG_HOME;
    if (envSnapshot.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = envSnapshot.XDG_DATA_HOME;
    if (envSnapshot.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = envSnapshot.HOME;

    for (const snapshot of fileSnapshots.splice(0, fileSnapshots.length)) {
      const parentDir = path.dirname(snapshot.filePath);
      if (snapshot.existed) {
        fs.mkdirSync(parentDir, { recursive: true });
        fs.writeFileSync(snapshot.filePath, snapshot.content ?? '', 'utf-8');
      } else if (fs.existsSync(snapshot.filePath)) {
        fs.rmSync(snapshot.filePath, { force: true });
      }
    }

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
    homeDir: string;
    fakeServerPath: string;
  } {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-test-'));
    const xdgConfigHome = path.join(rootDir, 'xdg-config');
    const xdgDataHome = path.join(rootDir, 'xdg-data');
    const homeDir = os.homedir();
    const fakeServerPath = path.join(rootDir, 'dist', 'mcp-server.js');

    fs.mkdirSync(path.dirname(fakeServerPath), { recursive: true });
    fs.writeFileSync(fakeServerPath, 'export {};\n', 'utf-8');
    fs.mkdirSync(xdgConfigHome, { recursive: true });
    fs.mkdirSync(xdgDataHome, { recursive: true });

    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    process.env.XDG_DATA_HOME = xdgDataHome;

    const homeConfigPaths = [
      path.join(homeDir, '.claude', 'settings.json'),
      path.join(homeDir, '.cursor', 'mcp.json'),
      path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
    ];
    for (const filePath of homeConfigPaths) {
      if (fs.existsSync(filePath)) {
        fileSnapshots.push({
          filePath,
          existed: true,
          content: fs.readFileSync(filePath, 'utf-8'),
        });
      } else {
        fileSnapshots.push({ filePath, existed: false });
      }
    }

    tempDirs.push(rootDir);

    return { rootDir, xdgConfigHome, xdgDataHome, homeDir, fakeServerPath };
  }

  async function loadFreshSetupModule() {
    return import(`../src/setup.js?test=${Date.now()}-${Math.random()}`);
  }

  it('produces correct dry-run output format for all 5 clients', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    for (const testCase of CLIENT_CASES) {
      const output = setupModule.install({
        client: testCase.client,
        serverPath: env.fakeServerPath,
        force: true,
        dryRun: true,
      });

      const expectedPath = testCase.getConfigPath(env);
      expect(output).toContain(`Dry run: Would add to ${expectedPath}`);
      expect(output).toContain(`"${env.fakeServerPath}"`);

      if (testCase.format === 'opencode') {
        expect(output).toContain('"type": "local"');
        expect(output).toContain('"command": [');
        expect(output).toContain('"enabled": true');
      } else {
        expect(output).toContain('"command": "bun"');
        expect(output).toContain('"args": [');
        expect(output).not.toContain('"type": "local"');
      }
    }
  });

  it('creates config at expected path with correct nested keys and MCP entry formats for all 5 clients', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    for (const testCase of CLIENT_CASES) {
      setupModule.install({
        client: testCase.client,
        serverPath: env.fakeServerPath,
        force: true,
      });

      const configPath = testCase.getConfigPath(env);
      expect(fs.existsSync(configPath)).toBe(true);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const entry = getNestedValue(config, testCase.mcpPath);

      expect(entry).toBeDefined();

      if (testCase.format === 'opencode') {
        expect(entry).toEqual({
          type: 'local',
          command: ['bun', 'run', env.fakeServerPath],
          enabled: true,
        });
      } else {
        expect(entry).toEqual({
          command: 'bun',
          args: ['run', env.fakeServerPath],
        });
      }
    }
  });

  it('is idempotent when install runs twice without force', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const first = setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });
    const second = setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });

    const configPath = path.join(env.xdgConfigHome, 'opencode', 'opencode.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      mcp: Record<string, unknown>;
    };

    expect(first).toContain('Installed open-zk-kb for OpenCode');
    expect(second).toContain('Already installed for OpenCode');
    expect(Object.keys(config.mcp)).toEqual(['open-zk-kb']);
  });

  it('uninstall removes existing MCP entry from config', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });

    const uninstallOutput = setupModule.uninstall({
      client: 'opencode',
    });

    const configPath = path.join(env.xdgConfigHome, 'opencode', 'opencode.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      mcp?: Record<string, unknown>;
    };

    expect(uninstallOutput).toContain('Uninstalled open-zk-kb from OpenCode');
    expect(config.mcp?.['open-zk-kb']).toBeUndefined();
  });

  it('install injects agent docs into client docs file', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    expect(fs.existsSync(agentDocsPath)).toBe(true);

    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('OPEN-ZK-KB:START');
    expect(content).toContain('OPEN-ZK-KB:END');
    expect(content).toContain('knowledge-search');
    expect(content).toContain('knowledge-store');
  });

  it('install preserves existing content in agent docs file', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, '# My Custom Rules\n\nDo not touch this.\n', 'utf-8');

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });

    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('# My Custom Rules');
    expect(content).toContain('Do not touch this.');
    expect(content).toContain('OPEN-ZK-KB:START');
    expect(content).toContain('OPEN-ZK-KB:END');
  });

  it('uninstall removes agent docs block from client docs file', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    expect(fs.existsSync(agentDocsPath)).toBe(true);

    setupModule.uninstall({ client: 'opencode' });

    // File with only managed block should be deleted entirely
    expect(fs.existsSync(agentDocsPath)).toBe(false);
  });

  it('uninstall preserves non-managed content in agent docs file', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, '# My Custom Rules\n\nDo not touch this.\n', 'utf-8');

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });

    setupModule.uninstall({ client: 'opencode' });

    expect(fs.existsSync(agentDocsPath)).toBe(true);
    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('# My Custom Rules');
    expect(content).toContain('Do not touch this.');
    expect(content).not.toContain('OPEN-ZK-KB:START');
    expect(content).not.toContain('OPEN-ZK-KB:END');
  });

  it('creates vault directory and index directory on install', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });

    const vaultPath = path.join(env.xdgDataHome, 'open-zk-kb');
    expect(fs.existsSync(vaultPath)).toBe(true);
    expect(fs.existsSync(path.join(vaultPath, '.index'))).toBe(true);
  });
});
