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

type McpClient = 'opencode' | 'claude-code' | 'cursor' | 'windsurf';

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

  it('produces correct dry-run output format for all 4 clients', async () => {
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

  it('creates config at expected path with correct nested keys and MCP entry formats for all 4 clients', async () => {
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

  describe('injectInstructions()', () => {
    let tempDir: string;
    let testFilePath: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inject-test-'));
      testFilePath = path.join(tempDir, 'test.md');
      tempDirs.push(tempDir);
    });

    it('creates new file with marker block when file does not exist', async () => {
      const setupModule = await loadFreshSetupModule();
      const result = setupModule.injectInstructions(testFilePath);

      expect(result.created).toBe(true);
      expect(result.updated).toBe(false);
      expect(fs.existsSync(testFilePath)).toBe(true);

      const content = fs.readFileSync(testFilePath, 'utf-8');
      expect(content).toContain('<!-- OPEN-ZK-KB:START');
      expect(content).toContain('<!-- OPEN-ZK-KB:END -->');
      expect(content).toContain('Knowledge Base (open-zk-kb)');
    });

    it('appends marker block to existing file without markers', async () => {
      const setupModule = await loadFreshSetupModule();
      const originalContent = '# My Notes\n\nSome content here.';
      fs.writeFileSync(testFilePath, originalContent);

      const result = setupModule.injectInstructions(testFilePath);

      expect(result.created).toBe(false);
      expect(result.updated).toBe(true);

      const content = fs.readFileSync(testFilePath, 'utf-8');
      expect(content).toContain(originalContent);
      expect(content).toContain('<!-- OPEN-ZK-KB:START');
      expect(content).toContain('<!-- OPEN-ZK-KB:END -->');
    });

    it('updates existing marker block (replaces content between markers)', async () => {
      const setupModule = await loadFreshSetupModule();
      const oldInstructions = '<!-- OPEN-ZK-KB:START — managed by open-zk-kb, do not edit -->\nOLD CONTENT\n<!-- OPEN-ZK-KB:END -->';
      const beforeMarker = '# Header\n\n';
      const afterMarker = '\n\n# Footer';
      fs.writeFileSync(testFilePath, beforeMarker + oldInstructions + afterMarker);

      const result = setupModule.injectInstructions(testFilePath);

      expect(result.created).toBe(false);
      expect(result.updated).toBe(true);

      const content = fs.readFileSync(testFilePath, 'utf-8');
      expect(content).toContain(beforeMarker);
      expect(content).toContain(afterMarker);
      expect(content).not.toContain('OLD CONTENT');
      expect(content).toContain('Knowledge Base (open-zk-kb)');
    });

    it('is idempotent (calling twice produces same result)', async () => {
      const setupModule = await loadFreshSetupModule();

      const result1 = setupModule.injectInstructions(testFilePath);
      const content1 = fs.readFileSync(testFilePath, 'utf-8');

      const result2 = setupModule.injectInstructions(testFilePath);
      const content2 = fs.readFileSync(testFilePath, 'utf-8');

      expect(result1.created).toBe(true);
      expect(result2.created).toBe(false);
      expect(result2.updated).toBe(false);
      expect(content1).toBe(content2);
    });

    it('preserves user content outside markers', async () => {
      const setupModule = await loadFreshSetupModule();
      const beforeMarker = '# My Custom Header\n\nImportant notes.\n\n';
      const afterMarker = '\n\n## Footer Section\n\nMore content.';
      fs.writeFileSync(testFilePath, beforeMarker + afterMarker);

      setupModule.injectInstructions(testFilePath);

      const content = fs.readFileSync(testFilePath, 'utf-8');
      expect(content).toContain('# My Custom Header');
      expect(content).toContain('Important notes.');
      expect(content).toContain('## Footer Section');
      expect(content).toContain('More content.');
    });

    it('dryRun=true does not write to disk', async () => {
      const setupModule = await loadFreshSetupModule();

      const result = setupModule.injectInstructions(testFilePath, true);

      expect(result.created).toBe(true);
      expect(fs.existsSync(testFilePath)).toBe(false);
    });
  });

  describe('removeInstructions()', () => {
    let tempDir: string;
    let testFilePath: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-test-'));
      testFilePath = path.join(tempDir, 'test.md');
      tempDirs.push(tempDir);
    });

    it('returns { removed: false } when file does not exist', async () => {
      const setupModule = await loadFreshSetupModule();

      const result = setupModule.removeInstructions(testFilePath);

      expect(result.removed).toBe(false);
    });

    it('returns { removed: false } when file has no markers', async () => {
      const setupModule = await loadFreshSetupModule();
      const content = '# My Notes\n\nNo markers here.';
      fs.writeFileSync(testFilePath, content);

      const result = setupModule.removeInstructions(testFilePath);

      expect(result.removed).toBe(false);
      expect(fs.readFileSync(testFilePath, 'utf-8')).toBe(content);
    });

    it('removes marker block and cleans up extra whitespace', async () => {
      const setupModule = await loadFreshSetupModule();
      const markedBlock = '<!-- OPEN-ZK-KB:START — managed by open-zk-kb, do not edit -->\nKB Instructions\n<!-- OPEN-ZK-KB:END -->';
      const content = '# Header\n\n\n' + markedBlock + '\n\n\n# Footer';
      fs.writeFileSync(testFilePath, content);

      const result = setupModule.removeInstructions(testFilePath);

      expect(result.removed).toBe(true);

      const updated = fs.readFileSync(testFilePath, 'utf-8');
      expect(updated).toContain('# Header');
      expect(updated).toContain('# Footer');
      expect(updated).not.toContain('KB Instructions');
      expect(updated).not.toContain('<!-- OPEN-ZK-KB:START');
      // Should have cleaned up extra newlines
      expect(updated).not.toContain('\n\n\n');
    });

    it('deletes file if marker block was the only content', async () => {
      const setupModule = await loadFreshSetupModule();
      const markedBlock = '<!-- OPEN-ZK-KB:START — managed by open-zk-kb, do not edit -->\nKB Instructions\n<!-- OPEN-ZK-KB:END -->';
      fs.writeFileSync(testFilePath, markedBlock);

      const result = setupModule.removeInstructions(testFilePath);

      expect(result.removed).toBe(true);
      expect(fs.existsSync(testFilePath)).toBe(false);
    });

    it('preserves user content outside markers', async () => {
      const setupModule = await loadFreshSetupModule();
      const beforeMarker = '# My Header\n\nUser content before.\n\n';
      const markedBlock = '<!-- OPEN-ZK-KB:START — managed by open-zk-kb, do not edit -->\nKB Instructions\n<!-- OPEN-ZK-KB:END -->';
      const afterMarker = '\n\n# Footer\n\nUser content after.';
      fs.writeFileSync(testFilePath, beforeMarker + markedBlock + afterMarker);

      setupModule.removeInstructions(testFilePath);

      const updated = fs.readFileSync(testFilePath, 'utf-8');
      expect(updated).toContain('# My Header');
      expect(updated).toContain('User content before.');
      expect(updated).toContain('# Footer');
      expect(updated).toContain('User content after.');
      expect(updated).not.toContain('KB Instructions');
    });

    it('dryRun=true does not modify file', async () => {
      const setupModule = await loadFreshSetupModule();
      const markedBlock = '<!-- OPEN-ZK-KB:START — managed by open-zk-kb, do not edit -->\nKB Instructions\n<!-- OPEN-ZK-KB:END -->';
      const content = '# Header\n\n' + markedBlock + '\n\n# Footer';
      fs.writeFileSync(testFilePath, content);

      const result = setupModule.removeInstructions(testFilePath, true);

      expect(result.removed).toBe(true);
      expect(fs.readFileSync(testFilePath, 'utf-8')).toBe(content);
    });
  });
});
