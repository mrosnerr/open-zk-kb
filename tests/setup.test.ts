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

interface DirSnapshot {
  dirPath: string;
  existed: boolean;
  files?: Map<string, string>; // relativePath -> content
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
  const dirSnapshots: DirSnapshot[] = [];

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

    // Restore snapshotted directories
    for (const snapshot of dirSnapshots.splice(0, dirSnapshots.length)) {
      if (snapshot.existed && snapshot.files) {
        // Clean directory first to remove any stale files created during test
        if (fs.existsSync(snapshot.dirPath)) {
          fs.rmSync(snapshot.dirPath, { recursive: true, force: true });
        }
        // Restore the directory and its contents
        fs.mkdirSync(snapshot.dirPath, { recursive: true });
        for (const [relativePath, content] of snapshot.files) {
          const fullPath = path.join(snapshot.dirPath, relativePath);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, content, 'utf-8');
        }
      } else if (!snapshot.existed && fs.existsSync(snapshot.dirPath)) {
        // Directory didn't exist before, remove it
        fs.rmSync(snapshot.dirPath, { recursive: true, force: true });
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
      path.join(homeDir, '.claude', 'CLAUDE.md'),
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

    // Snapshot skill directory state (claude-code installs here)
    // This ensures we restore it to pre-test state, not just delete it
    const skillDir = path.join(homeDir, '.claude', 'skills', 'open-zk-kb');
    if (fs.existsSync(skillDir)) {
      const files = new Map<string, string>();
      const walkDir = (dir: string, base: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.join(base, entry.name);
          if (entry.isDirectory()) {
            walkDir(fullPath, relativePath);
          } else {
            files.set(relativePath, fs.readFileSync(fullPath, 'utf-8'));
          }
        }
      };
      walkDir(skillDir, '');
      dirSnapshots.push({ dirPath: skillDir, existed: true, files });
    } else {
      dirSnapshots.push({ dirPath: skillDir, existed: false });
    }

    tempDirs.push(rootDir);

    return { rootDir, xdgConfigHome, xdgDataHome, homeDir, fakeServerPath };
  }

  async function loadFreshSetupModule() {
    return import(`../src/setup.js?test=${Date.now()}-${Math.random()}`);
  }

  async function loadFreshAgentDocsModule() {
    return import(`../src/agent-docs.js?test=${Date.now()}-${Math.random()}`);
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

  it('install uses compact instructions when instructionSize override is compact', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
      instructionSize: 'compact',
    });

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('OPEN-ZK-KB:START');
    // Compact version has the triggers line but no "Capture Checkpoints" section
    expect(content).toContain('Triggers');
    expect(content).not.toContain('Capture Checkpoints');
  });

  it('install uses full instructions by default for opencode', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('OPEN-ZK-KB:START');
    // Full version has the "Capture Checkpoints" section
    expect(content).toContain('Capture Checkpoints');
  });

  it('install injects agent docs for windsurf with compact default', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'windsurf',
      serverPath: env.fakeServerPath,
    });

    const agentDocsPath = path.join(env.homeDir, '.codeium', 'windsurf', 'memories', 'global_rules.md');
    expect(fs.existsSync(agentDocsPath)).toBe(true);
    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('OPEN-ZK-KB:START');
    // Windsurf defaults to compact — no "Capture Checkpoints"
    expect(content).not.toContain('Capture Checkpoints');
  });

  it('inject repairs a partial managed block instead of appending another one', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, '# Existing\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nbroken', 'utf-8');

    agentDocsModule.injectAgentDocs(agentDocsPath, 'full');

    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content.match(/OPEN-ZK-KB:START/g)?.length).toBe(1);
    expect(content.match(/OPEN-ZK-KB:END/g)?.length).toBe(1);
    expect(content).toContain('# Existing');
  });

  it('remove strips a lone start marker without deleting trailing content', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, 'Intro\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\npartial', 'utf-8');

    const result = agentDocsModule.removeAgentDocs(agentDocsPath);
    const content = fs.readFileSync(agentDocsPath, 'utf-8');

    expect(result.action).toBe('removed');
    expect(content).toContain('Intro');
    expect(content).toContain('partial');
    expect(content).not.toContain('OPEN-ZK-KB:START');
  });

  it('inject preserves user content before an orphaned end marker', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, 'Intro\n\n<!-- OPEN-ZK-KB:END -->\nTail', 'utf-8');

    agentDocsModule.injectAgentDocs(agentDocsPath, 'full');

    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('Intro');
    expect(content).toContain('Tail');
    expect(content.match(/OPEN-ZK-KB:START/g)?.length).toBe(1);
    expect(content.match(/OPEN-ZK-KB:END/g)?.length).toBe(1);
  });

  it('remove preserves user content before an orphaned end marker', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, 'Intro\n\n<!-- OPEN-ZK-KB:END -->\nTail', 'utf-8');

    const result = agentDocsModule.removeAgentDocs(agentDocsPath);
    const content = fs.readFileSync(agentDocsPath, 'utf-8');

    expect(result.action).toBe('removed');
    expect(content).toBe('Intro\n\nTail\n');
  });

  it('uninstall preserves user content on both sides of a managed block', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, 'Intro\n', 'utf-8');

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });

    const installedContent = fs.readFileSync(agentDocsPath, 'utf-8');
    const managedBlock = installedContent.match(/<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->[\s\S]*?<!-- OPEN-ZK-KB:END -->/)?.[0];
    expect(managedBlock).toBeDefined();

    fs.writeFileSync(agentDocsPath, `Intro\n\n${managedBlock}\n\nTail\n`, 'utf-8');
    setupModule.uninstall({ client: 'opencode' });

    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('Intro');
    expect(content).toContain('Tail');
    expect(content).not.toContain('OPEN-ZK-KB:START');
    expect(content).not.toContain('OPEN-ZK-KB:END');
  });

  it('inject preserves lookalike non-managed markers', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, 'Intro\n\n<!-- OPEN-ZK-KB:START custom -->\nUser text\n<!-- OPEN-ZK-KB:END custom -->\n', 'utf-8');

    agentDocsModule.injectAgentDocs(agentDocsPath, 'full');

    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('<!-- OPEN-ZK-KB:START custom -->');
    expect(content).toContain('<!-- OPEN-ZK-KB:END custom -->');
    expect(content.match(/OPEN-ZK-KB:START -- managed by open-zk-kb/g)?.length).toBe(1);
    expect(content.match(/<!-- OPEN-ZK-KB:END -->/g)?.length).toBe(1);
  });

  it('inject repairs out-of-order markers without dropping surrounding content', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, 'Intro\n\n<!-- OPEN-ZK-KB:END -->\nMiddle\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nTail\n', 'utf-8');

    agentDocsModule.injectAgentDocs(agentDocsPath, 'full');

    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('Intro');
    expect(content).toContain('Middle');
    expect(content).toContain('Tail');
    expect(content.match(/OPEN-ZK-KB:START -- managed by open-zk-kb/g)?.length).toBe(1);
    expect(content.match(/<!-- OPEN-ZK-KB:END -->/g)?.length).toBe(1);
  });

  it('remove strips malformed markers without deleting unrelated content', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, 'Intro\n\n<!-- OPEN-ZK-KB:END -->\nMiddle\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nTail\n', 'utf-8');

    const result = agentDocsModule.removeAgentDocs(agentDocsPath);
    const content = fs.readFileSync(agentDocsPath, 'utf-8');

    expect(result.action).toBe('removed');
    expect(content).toContain('Intro');
    expect(content).toContain('Middle');
    expect(content).toContain('Tail');
    expect(content).not.toContain('OPEN-ZK-KB:START -- managed by open-zk-kb');
    expect(content).not.toContain('<!-- OPEN-ZK-KB:END -->');
  });

  it('inject leaves multiply-marked files intact apart from marker cleanup and fresh block', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, 'Intro\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld A\n<!-- OPEN-ZK-KB:END -->\n\nBetween\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld B\n<!-- OPEN-ZK-KB:END -->\n', 'utf-8');

    agentDocsModule.injectAgentDocs(agentDocsPath, 'full');

    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('Intro');
    expect(content).toContain('Between');
    expect(content).toContain('Old A');
    expect(content).toContain('Old B');
    expect(content.match(/OPEN-ZK-KB:START -- managed by open-zk-kb/g)?.length).toBe(1);
    expect(content.match(/<!-- OPEN-ZK-KB:END -->/g)?.length).toBe(1);
  });

  it('dry-run inject and remove do not modify malformed files', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    const original = 'Intro\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nTail\n';
    fs.writeFileSync(agentDocsPath, original, 'utf-8');

    agentDocsModule.injectAgentDocs(agentDocsPath, 'full', true);
    expect(fs.readFileSync(agentDocsPath, 'utf-8')).toBe(original);

    agentDocsModule.removeAgentDocs(agentDocsPath, true);
    expect(fs.readFileSync(agentDocsPath, 'utf-8')).toBe(original);
  });

  it('doctor reports a healthy opencode install', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });

    const output = setupModule.doctor({ client: 'opencode' });

    expect(output).toContain('open-zk-kb doctor');
    expect(output).toContain(`OK Vault exists at ${path.join(env.xdgDataHome, 'open-zk-kb')}`);
    expect(output).toContain(`OK Config file exists at ${path.join(env.xdgConfigHome, 'open-zk-kb', 'config.yaml')}`);
    expect(output).toContain(`OK OpenCode: MCP config looks healthy in ${path.join(env.xdgConfigHome, 'opencode', 'opencode.json')}`);
    expect(output).toContain(`OK OpenCode: managed instructions are healthy in ${path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md')}`);
    expect(output).toContain('- ERROR: 0');
  });

  it('doctor reports config-only status for zed', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'zed',
      serverPath: env.fakeServerPath,
    });

    const output = setupModule.doctor({ client: 'zed' });

    expect(output).toContain(`OK Zed: MCP config looks healthy in ${path.join(env.xdgConfigHome, 'zed', 'settings.json')}`);
    expect(output).toContain('INFO Zed: managed instructions are not currently supported');
    expect(output).toContain('- ERROR: 0');
  });

  it('doctor does not warn about unmanaged instruction files when client is not installed', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, '# Personal OpenCode rules\n', 'utf-8');

    const output = setupModule.doctor({ client: 'opencode' });

    expect(output).toContain(`INFO OpenCode: config file not found at ${path.join(env.xdgConfigHome, 'opencode', 'opencode.json')}`);
    expect(output).toContain(`INFO OpenCode: instruction file exists at ${agentDocsPath}, but open-zk-kb is not installed for this client`);
    expect(output).toContain('- WARN: 0');
    expect(output).toContain('- ERROR: 0');
  });

  it('doctor --fix repairs a malformed opencode MCP entry', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const configPath = path.join(env.xdgConfigHome, 'opencode', 'opencode.json');
    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });

    fs.writeFileSync(configPath, JSON.stringify({
      mcp: {
        'open-zk-kb': {
          command: ['bun', 'run', env.fakeServerPath],
        },
      },
    }, null, 2));

    const output = setupModule.doctor({ client: 'opencode', fix: true });
    const repaired = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      mcp: Record<string, unknown>;
    };

    expect(output).toContain(`FIXED OpenCode: repaired MCP config in ${configPath}`);
    expect(output).toContain('- FIXED: 1');
    expect(repaired.mcp['open-zk-kb']).toEqual({
      type: 'local',
      command: ['bun', 'run', env.fakeServerPath],
      enabled: true,
    });
  });

  it('doctor --fix repairs missing managed instructions for configured clients', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.writeFileSync(agentDocsPath, '# Custom rules only\n', 'utf-8');

    const output = setupModule.doctor({ client: 'opencode', fix: true });
    const content = fs.readFileSync(agentDocsPath, 'utf-8');

    expect(output).toContain(`FIXED OpenCode: repaired managed instructions in ${agentDocsPath}`);
    expect(output).toContain('- FIXED: 1');
    expect(content).toContain('# Custom rules only');
    expect(content).toContain('OPEN-ZK-KB:START');
    expect(content).toContain('OPEN-ZK-KB:END');
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

  // --- Claude Code skill installation tests ---

  it('install creates skill directory with SKILL.md for claude-code', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const skillPath = path.join(env.homeDir, '.claude', 'skills', 'open-zk-kb');
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.existsSync(path.join(skillPath, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillPath, 'kinds-reference.md'))).toBe(true);

    const skillContent = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf-8');
    expect(skillContent).toContain('name: open-zk-kb');
    expect(skillContent).toContain('description:');
    expect(skillContent).toContain('knowledge-search');
    expect(skillContent).toContain('knowledge-store');
  });

  it('install does not inject CLAUDE.md managed block for claude-code', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const claudeMdPath = path.join(env.homeDir, '.claude', 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      expect(content).not.toContain('OPEN-ZK-KB:START');
      expect(content).not.toContain('OPEN-ZK-KB:END');
    }
  });

  it('install migrates old CLAUDE.md managed block when installing skill', async () => {
    const env = createIsolatedInstallEnv();

    // Pre-create a CLAUDE.md with the old managed block
    const claudeMdPath = path.join(env.homeDir, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
    fs.writeFileSync(
      claudeMdPath,
      '# My Rules\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld instructions\n<!-- OPEN-ZK-KB:END -->\n\n# Other stuff\n',
      'utf-8',
    );

    const setupModule = await loadFreshSetupModule();
    const output = setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // Skill should be installed
    const skillPath = path.join(env.homeDir, '.claude', 'skills', 'open-zk-kb');
    expect(fs.existsSync(path.join(skillPath, 'SKILL.md'))).toBe(true);

    // Old managed block should be removed
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('# My Rules');
    expect(content).toContain('# Other stuff');
    expect(content).not.toContain('OPEN-ZK-KB:START');
    expect(content).not.toContain('OPEN-ZK-KB:END');
    expect(output).toContain('Migration');
  });

  it('skill install is idempotent with --force', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const skillPath = path.join(env.homeDir, '.claude', 'skills', 'open-zk-kb');
    const firstContent = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf-8');

    setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const secondContent = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf-8');
    expect(secondContent).toBe(firstContent);
  });

  it('uninstall removes skill directory for claude-code', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const skillPath = path.join(env.homeDir, '.claude', 'skills', 'open-zk-kb');
    expect(fs.existsSync(skillPath)).toBe(true);

    setupModule.uninstall({ client: 'claude-code' });
    expect(fs.existsSync(skillPath)).toBe(false);
  });

  it('dry-run install does not create skill files for claude-code', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const output = setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      dryRun: true,
      force: true,
    });

    const skillPath = path.join(env.homeDir, '.claude', 'skills', 'open-zk-kb');
    expect(fs.existsSync(skillPath)).toBe(false);
    expect(output).toContain('Would install skill');
  });

  it('doctor reports healthy skill for claude-code', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const output = setupModule.doctor({ client: 'claude-code' });
    expect(output).toContain('OK Claude Code: skill is healthy');
    expect(output).toContain('- ERROR: 0');
  });

  it('doctor --fix restores missing skill for claude-code', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // Remove the skill directory
    const skillPath = path.join(env.homeDir, '.claude', 'skills', 'open-zk-kb');
    fs.rmSync(skillPath, { recursive: true });

    const output = setupModule.doctor({ client: 'claude-code', fix: true });
    expect(output).toContain('FIXED Claude Code: restored skill');
    expect(fs.existsSync(path.join(skillPath, 'SKILL.md'))).toBe(true);
  });

  it('doctor detects stale CLAUDE.md managed block and fixes it', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // Manually create a stale CLAUDE.md block (simulating upgrade from old version)
    const claudeMdPath = path.join(env.homeDir, '.claude', 'CLAUDE.md');
    fs.writeFileSync(
      claudeMdPath,
      '<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nStale\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8',
    );

    const output = setupModule.doctor({ client: 'claude-code', fix: true });
    expect(output).toContain('FIXED Claude Code: removed stale CLAUDE.md managed block');
  });
});
