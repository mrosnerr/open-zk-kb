import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { installTtsrRule, removeTtsrRule } from '../src/setup.js';
import { OMP_AGENT_DOCS_PREAMBLE } from '../src/agent-docs-targets.js';
import { createTestHarness, cleanupTestHarness } from './harness.js';
import type { TestContext } from './harness.js';

interface EnvSnapshot {
  XDG_CONFIG_HOME?: string;
  XDG_DATA_HOME?: string;
  HOME?: string;
}



type McpClient = 'opencode' | 'claude-code' | 'cursor' | 'windsurf' | 'zed' | 'omp';

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
  {
    client: 'omp',
    getConfigPath: ({ homeDir }) => path.join(homeDir, '.omp', 'agent', 'mcp.json'),
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

function getExpectedPiPackageSource(): string {
  const testFilePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(testFilePath), '..');
}

function runBunCommand(
  env: {
    xdgConfigHome: string;
    xdgDataHome: string;
    homeDir: string;
  },
  args: string[],
): string {
  const result = Bun.spawnSync(
    [process.execPath, ...args],
    {
      cwd: getExpectedPiPackageSource(),
      env: {
        ...process.env,
        HOME: env.homeDir,
        XDG_CONFIG_HOME: env.xdgConfigHome,
        XDG_DATA_HOME: env.xdgDataHome,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

function runSetupCli(
  env: {
    xdgConfigHome: string;
    xdgDataHome: string;
    homeDir: string;
  },
  args: string[],
): string {
  return runBunCommand(env, ['run', 'src/setup.ts', ...args]);
}


const MANAGED_BLOCK_LINE_COUNT = 13;

function expectSlimAgentDocsBlock(content: string, usesOmpSkill = false): void {
  const block = content.match(
    /<!-- OPEN-ZK-KB:START(?: v[^\s]+)? -- managed by open-zk-kb, do not edit -->\n[\s\S]*?\n<!-- OPEN-ZK-KB:END -->/
  )?.[0];

  expect(block).toBeDefined();
  if (!block) throw new Error('Expected an open-zk-kb managed instruction block');

  expect(block.split('\n')).toHaveLength(MANAGED_BLOCK_LINE_COUNT);
  expect(block).toContain('Persistent cross-session memory via `knowledge-*` MCP tools.');
  expect(block).toContain('`knowledge-search` for relevant context.');
  expect(block).toContain("Filter by `project` and `kind`; follow each note's `<guidance>`.");
  expect(block).toContain('`knowledge-store` immediately, never defer:');
  expect(block).toContain('useful URL → resource (`knowledge-ingest` first).');
  expect(block).toContain('**Each note:** one concept only.');
  expect(block).toContain('Include a `summary` and imperative `guidance`.');
  expect(block).toContain('**Project session start:** `knowledge-overview`.');
  expect(block).toContain(
    usesOmpSkill
      ? '`skill://open-zk-kb`.'
      : '`knowledge-template --kind {kind}` and the `open-zk-kb` skill where supported.'
  );
  expect(block).not.toContain('Capture Checkpoints');
  expect(block).not.toContain('knowledge-mine');
  expect(block).not.toContain('knowledge-maintain');
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
      HOME: process.env.HOME,
    };
  });

  afterEach(() => {
    cleanupTestHarness(ctx);

    // Restore env vars
    if (envSnapshot.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = envSnapshot.XDG_CONFIG_HOME;
    if (envSnapshot.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = envSnapshot.XDG_DATA_HOME;
    if (envSnapshot.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = envSnapshot.HOME;

    // Clean up temp directories (includes all test artifacts)
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
    // Create a fully isolated environment — no real user directories are touched
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-test-'));
    const xdgConfigHome = path.join(rootDir, 'xdg-config');
    const xdgDataHome = path.join(rootDir, 'xdg-data');
    const homeDir = path.join(rootDir, 'home'); // Use temp home, not real home
    const fakeServerPath = path.join(rootDir, 'dist', 'mcp-server.js');

    fs.mkdirSync(path.dirname(fakeServerPath), { recursive: true });
    fs.writeFileSync(fakeServerPath, 'export {};\n', 'utf-8');
    fs.mkdirSync(xdgConfigHome, { recursive: true });
    fs.mkdirSync(xdgDataHome, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    // Set all env vars to use temp directories
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    process.env.XDG_DATA_HOME = xdgDataHome;
    process.env.HOME = homeDir;

    tempDirs.push(rootDir);

    return { rootDir, xdgConfigHome, xdgDataHome, homeDir, fakeServerPath };
  }

  async function loadFreshSetupModule() {
    return import(`../src/setup.js?test=${Date.now()}-${Math.random()}`);
  }

  async function loadFreshAgentDocsModule() {
    return import(`../src/agent-docs.js?test=${Date.now()}-${Math.random()}`);
  }

  describe('TTSR rule helpers', () => {
    function createTempRulesDir(): string {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ttsr-rule-test-'));
      tempDirs.push(rootDir);
      return path.join(rootDir, 'rules');
    }

    function expectTtsrRuleStructure(targetPath: string): void {
      const content = fs.readFileSync(targetPath, 'utf-8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      expect(frontmatterMatch).not.toBeNull();
      const frontmatter = frontmatterMatch?.[1] ?? '';
      const body = frontmatterMatch?.[2] ?? '';

      expect(frontmatter).toContain('condition:');
      expect(frontmatter).toContain('interruptMode: prose-only');
      expect(frontmatter).toContain('"I\'ll (remember|keep that in mind|make a note|note that for)"');
      expect(body).toContain('knowledge-store');
    }

    it('creates a missing nested rule file with TTSR frontmatter and enforcement body', () => {
      const rulePath = path.join(createTempRulesDir(), 'nested', 'omp-ttsr-enforce.md');

      const result = installTtsrRule(rulePath);

      expect(result).toEqual({ action: 'created', path: rulePath });
      expect(fs.existsSync(rulePath)).toBe(true);
      expectTtsrRuleStructure(rulePath);
    });

    it('overwrites an existing rule file with TTSR frontmatter and enforcement body', () => {
      const rulePath = path.join(createTempRulesDir(), 'omp-ttsr-enforce.md');
      fs.mkdirSync(path.dirname(rulePath), { recursive: true });
      fs.writeFileSync(rulePath, 'user edit that must be replaced\n', 'utf-8');

      const result = installTtsrRule(rulePath);

      expect(result).toEqual({ action: 'updated', path: rulePath });
      expectTtsrRuleStructure(rulePath);
      expect(fs.readFileSync(rulePath, 'utf-8')).not.toContain('user edit that must be replaced');
    });

    it('is idempotent when installing over an already managed TTSR rule', () => {
      const rulePath = path.join(createTempRulesDir(), 'omp-ttsr-enforce.md');
      installTtsrRule(rulePath);
      const firstInstall = fs.readFileSync(rulePath, 'utf-8');

      const result = installTtsrRule(rulePath);

      expect(result).toEqual({ action: 'updated', path: rulePath });
      expect(fs.readFileSync(rulePath, 'utf-8')).toBe(firstInstall);
      expectTtsrRuleStructure(rulePath);
    });

    it('skips symlink targets without touching the link or shared target', () => {
      const rulesDir = createTempRulesDir();
      const sharedTarget = path.join(rulesDir, 'shared-policy.md');
      const rulePath = path.join(rulesDir, 'omp-ttsr-enforce.md');
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(sharedTarget, 'shared policy stays user-owned\n', 'utf-8');
      fs.symlinkSync(sharedTarget, rulePath);

      const result = installTtsrRule(rulePath);

      expect(result).toEqual({ action: 'skipped-symlink', path: rulePath });
      expect(fs.lstatSync(rulePath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(rulePath)).toBe(sharedTarget);
      expect(fs.readFileSync(sharedTarget, 'utf-8')).toBe('shared policy stays user-owned\n');
    });

    it('reports dry-run install actions without creating or overwriting rule files', () => {
      const missingRulePath = path.join(createTempRulesDir(), 'dry-run', 'omp-ttsr-enforce.md');
      const existingRulePath = path.join(createTempRulesDir(), 'existing', 'omp-ttsr-enforce.md');
      fs.mkdirSync(path.dirname(existingRulePath), { recursive: true });
      fs.writeFileSync(existingRulePath, 'existing user content\n', 'utf-8');

      const created = installTtsrRule(missingRulePath, true);
      const updated = installTtsrRule(existingRulePath, true);

      expect(created).toEqual({ action: 'created', path: missingRulePath });
      expect(fs.existsSync(missingRulePath)).toBe(false);
      expect(fs.existsSync(path.dirname(missingRulePath))).toBe(false);
      expect(updated).toEqual({ action: 'updated', path: existingRulePath });
      expect(fs.readFileSync(existingRulePath, 'utf-8')).toBe('existing user content\n');
    });

    it('removes an existing rule file and reports not-found on a second removal', () => {
      const rulePath = path.join(createTempRulesDir(), 'omp-ttsr-enforce.md');
      installTtsrRule(rulePath);

      const removed = removeTtsrRule(rulePath);
      const removedAgain = removeTtsrRule(rulePath);

      expect(removed).toEqual({ action: 'removed', path: rulePath });
      expect(fs.existsSync(rulePath)).toBe(false);
      expect(removedAgain).toEqual({ action: 'not-found', path: rulePath });
    });

    it('reports a dry-run removal while leaving the rule file present', () => {
      const rulePath = path.join(createTempRulesDir(), 'omp-ttsr-enforce.md');
      installTtsrRule(rulePath);

      const result = removeTtsrRule(rulePath, true);

      expect(result).toEqual({ action: 'removed', path: rulePath });
      expect(fs.existsSync(rulePath)).toBe(true);
      expectTtsrRuleStructure(rulePath);
    });

    it('removes only the targeted rule file and preserves another user file in the rules dir', () => {
      const rulesDir = createTempRulesDir();
      const rulePath = path.join(rulesDir, 'omp-ttsr-enforce.md');
      const userRulePath = path.join(rulesDir, 'user-authored.md');
      installTtsrRule(rulePath);
      fs.writeFileSync(userRulePath, '# User-authored rule\n\nDo not remove this.\n', 'utf-8');

      const result = removeTtsrRule(rulePath);

      expect(result).toEqual({ action: 'removed', path: rulePath });
      expect(fs.existsSync(rulePath)).toBe(false);
      expect(fs.readFileSync(userRulePath, 'utf-8')).toBe('# User-authored rule\n\nDo not remove this.\n');
    });
  });

  it('produces correct dry-run output format for all 6 MCP clients', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    for (const testCase of CLIENT_CASES) {
      const { output: output } = setupModule.install({
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
        expect(output).not.toContain('Plugin:');
      } else {
        expect(output).toContain('"command": "bun"');
        expect(output).toContain('"args": [');
        expect(output).not.toContain('"type": "local"');
      }
    }
  });

  it('creates config at expected path with correct nested keys and MCP entry formats for all 6 MCP clients', async () => {
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
        expect(config.plugin).toBeUndefined();
      } else {
        expect(entry).toEqual({
          command: 'bun',
          args: ['run', env.fakeServerPath],
        });
      }
    }
  });

  it('installs Pi as a package source with managed AGENTS.md instructions', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const { output: output } = setupModule.install({
      client: 'pi',
      force: true,
    });

    const settingsPath = path.join(env.homeDir, '.pi', 'agent', 'settings.json');
    const agentDocsPath = path.join(env.homeDir, '.pi', 'agent', 'AGENTS.md');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { packages?: string[] };

    expect(output).toContain('Installed open-zk-kb for Pi');
    expect(output).toContain(`Package: ${getExpectedPiPackageSource()}`);
    expect(settings.packages).toEqual([getExpectedPiPackageSource()]);
    expect(fs.existsSync(agentDocsPath)).toBe(true);
    const agentDocs = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(agentDocs).toContain('OPEN-ZK-KB:START');
    expectSlimAgentDocsBlock(agentDocs);
    expect(output).toContain('Pi does not support MCP natively');
  });

  it('adds HTTP bearer auth headers to generated MCP configs without printing the token', () => {
    const env = createIsolatedInstallEnv();
    const authToken = 'setup-test-auth-token';
    const serverConfigPath = path.join(env.xdgConfigHome, 'open-zk-kb', 'config.yaml');
    fs.mkdirSync(path.dirname(serverConfigPath), { recursive: true });
    fs.writeFileSync(
      serverConfigPath,
      `server:\n  host: 127.0.0.1\n  port: 19444\n  authToken: ${authToken}\n`,
      'utf-8',
    );

    for (const testCase of CLIENT_CASES) {
      const output = runSetupCli(env, [
        'install',
        '--client',
        testCase.client,
        '--transport',
        'http',
        '--force',
      ]);

      expect(output).not.toContain(authToken);

      const config = JSON.parse(fs.readFileSync(testCase.getConfigPath(env), 'utf-8')) as Record<string, unknown>;
      expect(getNestedValue(config, testCase.mcpPath)).toEqual({
        type: 'http',
        url: 'http://127.0.0.1:19444/mcp',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
    }

    const dryRunOutput = runSetupCli(env, [
      'install',
      '--client',
      'opencode',
      '--transport',
      'http',
      '--force',
      '--dry-run',
    ]);
    expect(dryRunOutput).toContain('Bearer [REDACTED]');
    expect(dryRunOutput).not.toContain(authToken);

    const warningOutput = runBunCommand(env, [
      '--eval',
      "import { CLIENT_CONFIGS, install } from './src/setup.js'; CLIENT_CONFIGS.opencode.httpAuthHeaderField = undefined; process.stdout.write(install({ client: 'opencode', transport: 'http', force: true }).output);",
    ]);
    expect(warningOutput).toContain('Warning: OpenCode does not support HTTP MCP authorization headers.');
    expect(warningOutput).not.toContain(authToken);
  });

  it('Pi dry-run previews package setup without requiring an MCP server path', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const { output: output } = setupModule.install({
      client: 'pi',
      dryRun: true,
    });

    expect(output).toContain(`Dry run: Would add Pi package source to ${path.join(env.homeDir, '.pi', 'agent', 'settings.json')}`);
    expect(output).toContain(getExpectedPiPackageSource());
    expect(output).toContain(`Would inject agent docs into ${path.join(env.homeDir, '.pi', 'agent', 'AGENTS.md')}`);
    expect(output).toContain('Pi does not support MCP natively');
  });

  it('Pi uninstall removes only the open-zk-kb package source and managed instructions', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const settingsPath = path.join(env.homeDir, '.pi', 'agent', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: ['npm:other-package'] }, null, 2), 'utf-8');

    setupModule.install({
      client: 'pi',
      force: true,
    });

    const uninstallResult = setupModule.uninstall({ client: 'pi' });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { packages?: string[] };
    const agentDocsPath = path.join(env.homeDir, '.pi', 'agent', 'AGENTS.md');

    expect(uninstallResult.output).toContain('Uninstalled open-zk-kb from Pi');
    expect(settings.packages).toEqual(['npm:other-package']);
    expect(fs.existsSync(agentDocsPath)).toBe(false);
  });

  it('Pi uninstall removes open-zk-kb package sources even when they differ from the current install source', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const settingsPath = path.join(env.homeDir, '.pi', 'agent', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      packages: ['npm:open-zk-kb@latest', 'npm:other-package'],
    }, null, 2), 'utf-8');

    const uninstallResult = setupModule.uninstall({ client: 'pi' });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { packages?: string[] };

    expect(uninstallResult.status).toBe('uninstalled');
    expect(settings.packages).toEqual(['npm:other-package']);
  });

  it('is idempotent when install runs twice without force', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const { output: first } = setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
    });
    const { output: second } = setupModule.install({
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

    const uninstallResult = setupModule.uninstall({
      client: 'opencode',
    });

    const configPath = path.join(env.xdgConfigHome, 'opencode', 'opencode.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      mcp?: Record<string, unknown>;
    };

    expect(uninstallResult.output).toContain('Uninstalled open-zk-kb from OpenCode');
    expect(config.mcp?.['open-zk-kb']).toBeUndefined();
  });

  it('opencode install preserves existing plugin entries without adding open-zk-kb', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const configPath = path.join(env.xdgConfigHome, 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      plugin: ['oh-my-openagent', '@rehydra/opencode'],
    }, null, 2));

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      plugin?: string[];
      mcp?: Record<string, unknown>;
    };

    expect(config.plugin).toEqual(['oh-my-openagent', '@rehydra/opencode']);
    expect(config.mcp?.['open-zk-kb']).toEqual({
      type: 'local',
      command: ['bun', 'run', env.fakeServerPath],
      enabled: true,
    });
  });

  it('opencode uninstall leaves unrelated plugin entries untouched', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const configPath = path.join(env.xdgConfigHome, 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      plugin: ['oh-my-openagent', '@rehydra/opencode'],
    }, null, 2));

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
      force: true,
    });

    setupModule.uninstall({ client: 'opencode' });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      plugin?: string[];
      mcp?: Record<string, unknown>;
    };

    expect(config.plugin).toEqual(['oh-my-openagent', '@rehydra/opencode']);
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
    expectSlimAgentDocsBlock(content);
  });
  it('uses the slim managed instruction block for every instruction size', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();
    for (const size of ['full', 'compact', 'rules', 'preflight'] as const) {
      const agentDocsPath = path.join(env.rootDir, `${size}.md`);
      agentDocsModule.injectAgentDocs(agentDocsPath, size);
      expectSlimAgentDocsBlock(fs.readFileSync(agentDocsPath, 'utf-8'), size === 'preflight');
    }
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

  it('OMP uninstall deletes the rule file when only the injected preamble remains', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const rulePath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb.md');
    expect(fs.existsSync(rulePath)).toBe(true);
    expect(fs.readFileSync(rulePath, 'utf-8')).toContain('alwaysApply: true');

    setupModule.uninstall({ client: 'omp' });

    expect(fs.existsSync(rulePath)).toBe(false);
  });

  it('OMP install prepends preamble to existing marker-less rule files once', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const rulePath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb.md');
    fs.mkdirSync(path.dirname(rulePath), { recursive: true });
    fs.writeFileSync(rulePath, 'User-owned rule content.\n', 'utf-8');

    const firstResult = agentDocsModule.injectAgentDocs(
      rulePath,
      'preflight',
      false,
      'omp',
      '1.2.0',
      OMP_AGENT_DOCS_PREAMBLE
    );

    const firstContent = fs.readFileSync(rulePath, 'utf-8');
    expect(firstResult.action).toBe('updated');
    expect(firstContent.startsWith(OMP_AGENT_DOCS_PREAMBLE)).toBe(true);
    expect(firstContent).toContain('User-owned rule content.');
    expectSlimAgentDocsBlock(firstContent, true);
    expect(firstContent.match(/OPEN-ZK-KB:START/g)?.length).toBe(1);
    expect(firstContent.match(/OPEN-ZK-KB:END/g)?.length).toBe(1);
    expect(firstContent.split(OMP_AGENT_DOCS_PREAMBLE).length - 1).toBe(1);

    const secondResult = agentDocsModule.injectAgentDocs(
      rulePath,
      'preflight',
      false,
      'omp',
      '1.2.0',
      OMP_AGENT_DOCS_PREAMBLE
    );

    expect(secondResult.action).toBe('unchanged');
    expect(fs.readFileSync(rulePath, 'utf-8')).toBe(firstContent);
  });

  it('OMP uninstall preserves rule files with user content outside the managed block', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const rulePath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb.md');
    fs.appendFileSync(rulePath, '\nUser-authored rule content.\n', 'utf-8');

    setupModule.uninstall({ client: 'omp' });

    expect(fs.existsSync(rulePath)).toBe(true);
    const content = fs.readFileSync(rulePath, 'utf-8');
    expect(content).toContain('alwaysApply: true');
    expect(content).toContain('User-authored rule content.');
    expect(content).not.toContain('OPEN-ZK-KB:START');
    expect(content).not.toContain('OPEN-ZK-KB:END');
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
    expectSlimAgentDocsBlock(content);
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
    expectSlimAgentDocsBlock(content);
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
    expectSlimAgentDocsBlock(content);
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
    // Match versioned or unversioned start marker
    const managedBlock = installedContent.match(/<!-- OPEN-ZK-KB:START(?: v[^\s]+)? -- managed by open-zk-kb, do not edit -->[\s\S]*?<!-- OPEN-ZK-KB:END -->/)?.[0];
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

  it('inject removes duplicate managed block bodies while preserving surrounding content', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, 'Intro\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld A\n<!-- OPEN-ZK-KB:END -->\n\nBetween\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld B\n<!-- OPEN-ZK-KB:END -->\n', 'utf-8');

    agentDocsModule.injectAgentDocs(agentDocsPath, 'full');

    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('Intro');
    expect(content).toContain('Between');
    expect(content).not.toContain('Old A');
    expect(content).not.toContain('Old B');
    expect(content.match(/OPEN-ZK-KB:START -- managed by open-zk-kb/g)?.length).toBe(1);
    expect(content.match(/<!-- OPEN-ZK-KB:END -->/g)?.length).toBe(1);
  });

  it('inject preserves content after unmatched start markers before later managed blocks', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, 'Intro\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nUser text\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld block\n<!-- OPEN-ZK-KB:END -->\nTail\n', 'utf-8');

    agentDocsModule.injectAgentDocs(agentDocsPath, 'full');

    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('Intro');
    expect(content).toContain('User text');
    expect(content).toContain('Tail');
    expect(content).not.toContain('Old block');
    expect(content.match(/OPEN-ZK-KB:START -- managed by open-zk-kb/g)?.length).toBe(1);
    expect(content.match(/<!-- OPEN-ZK-KB:END -->/g)?.length).toBe(1);
  });

  it('inject replaces a block with a pre-release versioned marker', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath, 'Intro\n\n<!-- OPEN-ZK-KB:START v1.0.0-dev.gabc1234 -- managed by open-zk-kb, do not edit -->\nOld content\n<!-- OPEN-ZK-KB:END -->\n', 'utf-8');

    agentDocsModule.injectAgentDocs(agentDocsPath, 'full', false, undefined, '1.1.0');

    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('Intro');
    expect(content).not.toContain('Old content');
    expect(content).not.toContain('v1.0.0-dev');
    expect(content.match(/OPEN-ZK-KB:START/g)?.length).toBe(1);
    expect(content.match(/OPEN-ZK-KB:END/g)?.length).toBe(1);
  });

  it('inject repairs duplicate blocks with pre-release versioned markers', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath,
      'Intro\n\n' +
      '<!-- OPEN-ZK-KB:START v1.1.0-dev.gc67c501 -- managed by open-zk-kb, do not edit -->\nBlock A\n<!-- OPEN-ZK-KB:END -->\n\n' +
      '<!-- OPEN-ZK-KB:START v1.1.0-dev.gda98bb8 -- managed by open-zk-kb, do not edit -->\nBlock B\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8'
    );

    agentDocsModule.injectAgentDocs(agentDocsPath, 'full');

    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('Intro');
    expect(content).not.toContain('Block A');
    expect(content).not.toContain('Block B');
    expect(content.match(/OPEN-ZK-KB:START/g)?.length).toBe(1);
    expect(content.match(/OPEN-ZK-KB:END/g)?.length).toBe(1);
  });

  describe('agent docs maintain preserves user frontmatter', () => {
    it('rewrites only the managed block in a rules file with existing YAML frontmatter', async () => {
      const env = createIsolatedInstallEnv();
      const agentDocsModule = await loadFreshAgentDocsModule();

      const rulesPath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb.md');
      fs.mkdirSync(path.dirname(rulesPath), { recursive: true });

      const userFrontmatter = [
        '---',
        'alwaysApply: false',
        'description: User-owned OMP rule metadata',
        'globs:',
        '  - "**/*.md"',
        '---',
        '',
      ].join('\n');
      const originalManagedBlock = [
        '<!-- OPEN-ZK-KB:START v0.9.0 -- managed by open-zk-kb, do not edit -->',
        'stale managed instructions',
        '<!-- OPEN-ZK-KB:END -->',
        '',
      ].join('\n');
      const userTail = '# User rule notes\nKeep this outside the managed block.\n';
      fs.writeFileSync(rulesPath, userFrontmatter + originalManagedBlock + userTail, 'utf-8');

      const result = agentDocsModule.injectAgentDocs(rulesPath, 'preflight', false, 'omp', '1.2.0');

      const updated = fs.readFileSync(rulesPath, 'utf-8');
      const frontmatterEnd = updated.indexOf('<!-- OPEN-ZK-KB:START');
      const updatedFrontmatter = updated.slice(0, frontmatterEnd);
      const managedBlock = updated.match(/<!-- OPEN-ZK-KB:START(?: v[^\s]+)? -- managed by open-zk-kb, do not edit -->[\s\S]*?<!-- OPEN-ZK-KB:END -->/)?.[0];

      expect(result.action).toBe('updated');
      expect(updatedFrontmatter).toBe(userFrontmatter);
      expect(managedBlock).toBeDefined();
      expect(managedBlock).not.toContain('stale managed instructions');
      expect(managedBlock).toContain('v1.2.0');
      expect(updated).toContain(userTail);
      expect(updated.match(/OPEN-ZK-KB:START/g)?.length).toBe(1);
      expect(updated.match(/OPEN-ZK-KB:END/g)?.length).toBe(1);
    });
  });

  it('extractManagedBlockVersion handles pre-release suffixes', async () => {
    const agentDocsModule = await loadFreshAgentDocsModule();

    expect(agentDocsModule.extractManagedBlockVersion(
      '<!-- OPEN-ZK-KB:START v1.1.0-dev.gc67c501 -- managed by open-zk-kb, do not edit -->'
    )).toBe('1.1.0-dev.gc67c501');

    expect(agentDocsModule.extractManagedBlockVersion(
      '<!-- OPEN-ZK-KB:START v1.0.0 -- managed by open-zk-kb, do not edit -->'
    )).toBe('1.0.0');

    expect(agentDocsModule.extractManagedBlockVersion(
      '<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->'
    )).toBeNull();
  });

  it('inspectAgentDocs detects multiple-markers with pre-release versions', async () => {
    const env = createIsolatedInstallEnv();
    const agentDocsModule = await loadFreshAgentDocsModule();

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.writeFileSync(agentDocsPath,
      '<!-- OPEN-ZK-KB:START v1.1.0-dev.gc67c501 -- managed by open-zk-kb, do not edit -->\nA\n<!-- OPEN-ZK-KB:END -->\n\n' +
      '<!-- OPEN-ZK-KB:START v1.1.0-dev.gda98bb8 -- managed by open-zk-kb, do not edit -->\nB\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8'
    );

    const inspection = agentDocsModule.inspectAgentDocs(agentDocsPath);
    expect(inspection.status).toBe('multiple-markers');
    expect(inspection.startCount).toBe(2);
    expect(inspection.endCount).toBe(2);
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

  it('doctor reports a healthy Pi package install', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'pi',
      force: true,
    });

    const output = setupModule.doctor({ client: 'pi' });

    expect(output).toContain(`OK Pi: package source looks healthy in ${path.join(env.homeDir, '.pi', 'agent', 'settings.json')}`);
    expect(output).toContain(`OK Pi: managed instructions are healthy in ${path.join(env.homeDir, '.pi', 'agent', 'AGENTS.md')}`);
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
      plugin?: string[];
    };

    expect(output).toContain(`FIXED OpenCode: repaired MCP config in ${configPath}`);
    expect(output).toContain('- FIXED: 1');
    expect(repaired.mcp['open-zk-kb']).toEqual({
      type: 'local',
      command: ['bun', 'run', env.fakeServerPath],
      enabled: true,
    });
    expect(repaired.plugin).toBeUndefined();
  });

  it('doctor --fix removes stale opencode plugin entries', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const configPath = path.join(env.xdgConfigHome, 'opencode', 'opencode.json');
    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    config.plugin = ['oh-my-openagent', 'open-zk-kb', 'open-zk-kb@dev', 'open-zk-kb/plugin'];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const output = setupModule.doctor({ client: 'opencode', fix: true });
    const repaired = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      plugin?: string[];
    };

    expect(output).toContain(`FIXED OpenCode: removed stale open-zk-kb plugin entries from ${configPath}`);
    expect(repaired.plugin).toEqual(['oh-my-openagent']);
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

  it('install creates skill through dangling parent symlink', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Create ~/.claude but make skills/ a dangling symlink
    const claudeDir = path.join(env.homeDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const danglingTarget = path.join(env.homeDir, 'nonexistent', 'skills');
    fs.symlinkSync(danglingTarget, path.join(claudeDir, 'skills'));

    // Sanity: the symlink target doesn't exist
    expect(fs.existsSync(danglingTarget)).toBe(false);

    setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // Skill should be installed through the symlink
    const skillPath = path.join(claudeDir, 'skills', 'open-zk-kb');
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.existsSync(path.join(skillPath, 'SKILL.md'))).toBe(true);

    // The dangling target should now exist
    expect(fs.existsSync(danglingTarget)).toBe(true);
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
    const { output: output } = setupModule.install({
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

  it('claude-code install creates both skill and rules file', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const { output } = setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // Skill should be installed
    const skillPath = path.join(env.homeDir, '.claude', 'skills', 'open-zk-kb');
    expect(fs.existsSync(path.join(skillPath, 'SKILL.md'))).toBe(true);

    // Rules file should be installed
    const rulesPath = path.join(env.homeDir, '.claude', 'rules', 'open-zk-kb.md');
    expect(fs.existsSync(rulesPath)).toBe(true);
    const rulesContent = fs.readFileSync(rulesPath, 'utf-8');
    expect(rulesContent).toContain('OPEN-ZK-KB:START');
    expectSlimAgentDocsBlock(rulesContent);
    expect(rulesContent).not.toContain('client: "');

    expect(output).toContain('Skill:');
    expect(output).toContain('Rule:');
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


  it('uninstall removes config-less claude-code skill and rule artifacts', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const configPath = path.join(env.homeDir, '.claude', 'settings.json');
    const skillPath = path.join(env.homeDir, '.claude', 'skills', 'open-zk-kb');
    const rulesPath = path.join(env.homeDir, '.claude', 'rules', 'open-zk-kb.md');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(path.join(skillPath, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(rulesPath)).toBe(true);

    fs.rmSync(configPath);

    const result = setupModule.uninstall({ client: 'claude-code' });

    expect(result.status).toBe('uninstalled');
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(skillPath)).toBe(false);
    expect(fs.existsSync(rulesPath)).toBe(false);
    expect(result.output).toContain('Uninstalled open-zk-kb from Claude Code');
  });

  it('hasAuxiliaryInstallArtifacts detects config-less claude-code skill artifact', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const configPath = path.join(env.homeDir, '.claude', 'settings.json');
    const skillPath = path.join(env.homeDir, '.claude', 'skills', 'open-zk-kb');
    const rulesPath = path.join(env.homeDir, '.claude', 'rules', 'open-zk-kb.md');

    fs.rmSync(configPath);
    fs.rmSync(rulesPath);

    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(path.join(skillPath, 'SKILL.md'))).toBe(true);
    expect(setupModule.hasAuxiliaryInstallArtifacts(setupModule.CLIENT_CONFIGS['claude-code'])).toBe(true);
  });
  it('dry-run install does not create skill files for claude-code', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const { output: output } = setupModule.install({
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

  it('install creates skill directory with SKILL.md for omp', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const skillPath = path.join(env.homeDir, '.omp', 'agent', 'skills', 'open-zk-kb');
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.existsSync(path.join(skillPath, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillPath, 'kinds-reference.md'))).toBe(true);

    const skillContent = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf-8');
    expect(skillContent).toContain('name: open-zk-kb');
    expect(skillContent).toContain('description:');
    expect(skillContent).toContain('knowledge-search');
    expect(skillContent).toContain('knowledge-store');
  });

  it('install writes standard mcpServers entry for omp', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const configPath = path.join(env.homeDir, '.omp', 'agent', 'mcp.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers['open-zk-kb']).toBeDefined();
    expect(config.mcpServers['open-zk-kb'].command).toBe('bun');
    expect(config.mcpServers['open-zk-kb'].args).toContain('run');
  });

  it('omp install removes the uninstall discovery disable', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const configPath = path.join(env.homeDir, '.omp', 'agent', 'mcp.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      disabledServers: ['other-server', 'open-zk-kb'],
    }, null, 2), 'utf-8');

    const result = setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['open-zk-kb']).toBeDefined();
    expect(config.disabledServers).toEqual(['other-server']);
    expect(result.details).toContain(`Discovery: re-enabled open-zk-kb in ${configPath}`);
  });

  it('omp dry-run install reports discovery re-enable without writing it', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const configPath = path.join(env.homeDir, '.omp', 'agent', 'mcp.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'open-zk-kb': { command: 'bun', args: ['run', env.fakeServerPath] },
      },
      disabledServers: ['open-zk-kb'],
    }, null, 2), 'utf-8');

    const result = setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      dryRun: true,
    });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.disabledServers).toEqual(['open-zk-kb']);
    expect(result.output).toContain(`Would re-enable MCP discovery for open-zk-kb in ${configPath}`);
    expect(result.output).not.toContain('Discovery: re-enabled open-zk-kb');
  });


  it('omp install injects agent docs into rules/open-zk-kb.md AND installs skill (both)', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const { output: output } = setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // Skill should be installed
    const skillPath = path.join(env.homeDir, '.omp', 'agent', 'skills', 'open-zk-kb');
    expect(fs.existsSync(path.join(skillPath, 'SKILL.md'))).toBe(true);

    // Agent docs should be injected into rules/open-zk-kb.md (not AGENTS.md)
    const rulesPath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb.md');
    expect(fs.existsSync(rulesPath)).toBe(true);
    const content = fs.readFileSync(rulesPath, 'utf-8');
    expect(content).toContain('OPEN-ZK-KB:START');
    expect(content).toContain('OPEN-ZK-KB:END');
    expect(content).toContain('knowledge-search');
    expect(content).toContain('knowledge-store');
    // Instructions should not contain client-specific filtering
    expect(content).not.toContain('client: "');
    // New file should have YAML frontmatter preamble
    expect(content).toMatch(/^---\nalwaysApply: true/);

    // AGENTS.md should NOT exist (not our file to create)
    const agentsMdPath = path.join(env.homeDir, '.omp', 'agent', 'AGENTS.md');
    expect(fs.existsSync(agentsMdPath)).toBe(false);

    // Output should mention both
    expect(output).toContain('Skill:');
    expect(output).toContain('Rule:');
  });

  it('omp install preserves existing rules/open-zk-kb.md content when injecting', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const rulesPath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb.md');
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.writeFileSync(rulesPath, '# My Custom Rules\n\nNever commit secrets.\n', 'utf-8');

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const content = fs.readFileSync(rulesPath, 'utf-8');
    expect(content).toContain('# My Custom Rules');
    expect(content).toContain('Never commit secrets.');
    expect(content).toContain('OPEN-ZK-KB:START');
  });

  it('uninstall removes skill, agent docs from rules/open-zk-kb.md, and MCP entry for omp', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const skillPath = path.join(env.homeDir, '.omp', 'agent', 'skills', 'open-zk-kb');
    const configPath = path.join(env.homeDir, '.omp', 'agent', 'mcp.json');
    const rulesPath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(rulesPath, 'utf-8')).toContain('OPEN-ZK-KB:START');

    setupModule.uninstall({ client: 'omp' });
    expect(fs.existsSync(skillPath)).toBe(false);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['open-zk-kb']).toBeUndefined();
    expect(config.disabledServers).toContain('open-zk-kb');

    // Agent docs block should be removed (file deleted since it was only the managed block)
    if (fs.existsSync(rulesPath)) {
      const content = fs.readFileSync(rulesPath, 'utf-8');
      expect(content).not.toContain('OPEN-ZK-KB:START');
    }
  });

  it('uninstall removes leftover OMP managed docs when the MCP entry is already absent', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const configPath = path.join(env.homeDir, '.omp', 'agent', 'mcp.json');
    const rulesPath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb.md');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf-8');
    fs.writeFileSync(rulesPath, [
      '---',
      'alwaysApply: true',
      '---',
      '<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->',
      'Old instructions',
      '<!-- OPEN-ZK-KB:END -->',
      '',
    ].join('\n'), 'utf-8');

    const result = setupModule.uninstall({ client: 'omp' });

    expect(result.status).toBe('uninstalled');
    expect(result.details).toContain(`Config checked: ${configPath} (no active entry)`);
    if (fs.existsSync(rulesPath)) {
      expect(fs.readFileSync(rulesPath, 'utf-8')).not.toContain('OPEN-ZK-KB:START');
    }
  });

  it('omp uninstall disables discovery even when no native config exists', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const configPath = path.join(env.homeDir, '.omp', 'agent', 'mcp.json');

    const result = setupModule.uninstall({ client: 'omp' });

    expect(result.status).toBe('uninstalled');
    expect(result.details).toContain(`Discovery disabled: open-zk-kb in ${configPath}`);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers).toBeUndefined();
    expect(config.disabledServers).toEqual(['open-zk-kb']);
  });

  it('omp uninstall rejects non-array disabledServers instead of clobbering it', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const configPath = path.join(env.homeDir, '.omp', 'agent', 'mcp.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'open-zk-kb': { command: 'bun', args: ['run', env.fakeServerPath] },
      },
      disabledServers: 'open-zk-kb',
    }, null, 2), 'utf-8');

    expect(() => setupModule.uninstall({ client: 'omp' })).toThrow('disabledServers must be an array');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['open-zk-kb']).toBeDefined();
    expect(config.disabledServers).toBe('open-zk-kb');
  });


  it('rejects a config file whose JSON root is not an object', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const configPath = path.join(env.homeDir, '.omp', 'agent', 'mcp.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '[]', 'utf-8');

    expect(() => setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    })).toThrow('JSON root must be an object');
    expect(() => setupModule.uninstall({ client: 'omp' })).toThrow('JSON root must be an object');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('[]');
  });

  it('all-client uninstall disables OMP rediscovery when removing another MCP client', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'claude-code',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };

    try {
      await setupModule.runSetupCli(['uninstall', '--yes']);
    } finally {
      console.log = originalLog;
    }

    const claudeConfigPath = path.join(env.homeDir, '.claude', 'settings.json');
    const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf-8'));
    expect(claudeConfig.mcpServers['open-zk-kb']).toBeUndefined();

    const ompConfigPath = path.join(env.homeDir, '.omp', 'agent', 'mcp.json');
    const ompConfig = JSON.parse(fs.readFileSync(ompConfigPath, 'utf-8'));
    expect(ompConfig.disabledServers).toContain('open-zk-kb');
    expect(logs.join('\n')).toContain('Uninstalled open-zk-kb from OMP');
  });

  it('all-client uninstall removes leftover OMP artifacts when MCP entry is absent', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const configPath = path.join(env.homeDir, '.omp', 'agent', 'mcp.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf-8');

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };

    try {
      await setupModule.runSetupCli(['uninstall', '--yes']);
    } finally {
      console.log = originalLog;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const skillPath = path.join(env.homeDir, '.omp', 'agent', 'skills', 'open-zk-kb');
    const rulePath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb.md');
    const ttsrPath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb-enforce.md');

    expect(config.disabledServers).toContain('open-zk-kb');
    expect(fs.existsSync(skillPath)).toBe(false);
    if (fs.existsSync(rulePath)) {
      expect(fs.readFileSync(rulePath, 'utf-8')).not.toContain('OPEN-ZK-KB:START');
    }
    expect(fs.existsSync(ttsrPath)).toBe(false);
    expect(logs.join('\n')).toContain('Uninstalled open-zk-kb from OMP');
  });

  it('omp install preserves existing mcpServers entries', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const configPath = path.join(env.homeDir, '.omp', 'agent', 'mcp.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'other-server': { command: 'npx', args: ['-y', 'other-server'] },
      },
    }, null, 2), 'utf-8');

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['other-server']).toBeDefined();
    expect(config.mcpServers['open-zk-kb']).toBeDefined();
  });

  it('doctor reports healthy skill, agent docs, and TTSR rule for omp', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const output = setupModule.doctor({ client: 'omp' });
    expect(output).toContain('OK OMP: skill is healthy');
    expect(output).toContain('OK OMP: managed instructions are healthy');
    expect(output).toContain('OK OMP: TTSR enforcement rule is healthy');
    expect(output).toContain('- ERROR: 0');
  });

  // --- Symlink safety tests (generic, affects any client with agentDocsPath) ---

  it('install skips agent docs when path is a symlink to shared file', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Simulate ~/.config/opencode/AGENTS.md → ~/.agents/AGENTS.md
    const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile, '# Shared Global Rules\n', 'utf-8');

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.symlinkSync(sharedFile, agentDocsPath);

    const { output: output } = setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // Shared file must NOT be modified
    const sharedContent = fs.readFileSync(sharedFile, 'utf-8');
    expect(sharedContent).not.toContain('OPEN-ZK-KB');
    expect(sharedContent).toBe('# Shared Global Rules\n');

    // Output should report the skip with the resolved target
    expect(output).toContain('skipped');
    expect(output).toContain('.agents/AGENTS.md');
  });

  it('install injects into symlinked file when injectSharedAgentDocs is confirmed', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Simulate symlinked AGENTS.md
    const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile, '# Shared Rules\n', 'utf-8');

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.symlinkSync(sharedFile, agentDocsPath);

    const { output: output } = setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
      force: true,
      injectSharedAgentDocs: true,
    });

    // Shared file SHOULD be modified when user confirms
    const sharedContent = fs.readFileSync(sharedFile, 'utf-8');
    expect(sharedContent).toContain('# Shared Rules');
    expect(sharedContent).toContain('OPEN-ZK-KB:START');
    expect(sharedContent).not.toContain('client: "');

    // Output should report the injection, not a skip
    expect(output).toContain('Instructions:');
    expect(output).not.toContain('skipped');
  });

  it('uninstall does not touch symlinked agent docs file', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Install with confirmed injection into shared file
    const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile, '# Shared Rules\n', 'utf-8');

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.symlinkSync(sharedFile, agentDocsPath);

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
      force: true,
      injectSharedAgentDocs: true,
    });
    expect(fs.readFileSync(sharedFile, 'utf-8')).toContain('OPEN-ZK-KB:START');

    // Uninstall should NOT touch the symlinked file
    setupModule.uninstall({ client: 'opencode' });
    const sharedContent = fs.readFileSync(sharedFile, 'utf-8');
    expect(sharedContent).toContain('OPEN-ZK-KB:START');
  });

  it('doctor reports symlink info for client with symlinked agentDocsPath', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Simulate symlinked AGENTS.md for opencode
    const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile, '# Shared\n', 'utf-8');

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.symlinkSync(sharedFile, agentDocsPath);

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const output = setupModule.doctor({ client: 'opencode' });
    expect(output).toContain('OK OpenCode: MCP config looks healthy');
    expect(output).toContain('INFO OpenCode: agent docs path is a symlink');
    expect(output).toContain('- ERROR: 0');
  });

  it('non-symlinked agentDocsPath is injected and cleaned up normally', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Windsurf uses a non-symlinked path
    setupModule.install({
      client: 'windsurf',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const agentDocsPath = path.join(env.homeDir, '.codeium', 'windsurf', 'memories', 'global_rules.md');
    expect(fs.existsSync(agentDocsPath)).toBe(true);
    const content = fs.readFileSync(agentDocsPath, 'utf-8');
    expect(content).toContain('OPEN-ZK-KB:START');
    expect(content).not.toContain('client: "');

    // Uninstall should clean up
    setupModule.uninstall({ client: 'windsurf' });
    if (fs.existsSync(agentDocsPath)) {
      expect(fs.readFileSync(agentDocsPath, 'utf-8')).not.toContain('OPEN-ZK-KB:START');
    }
  });

  // --- Stale location cleanup tests ---

  it('omp install cleans up stale managed blocks from AGENTS.md and RULES.md', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Simulate a leftover managed block in the old AGENTS.md location
    const staleAgentsPath = path.join(env.homeDir, '.omp', 'agent', 'AGENTS.md');
    fs.mkdirSync(path.dirname(staleAgentsPath), { recursive: true });
    fs.writeFileSync(staleAgentsPath,
      '# My Rules\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld instructions\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8',
    );

    // Simulate a leftover managed block in the old RULES.md location
    const staleRulesPath = path.join(env.homeDir, '.omp', 'agent', 'RULES.md');
    fs.writeFileSync(staleRulesPath,
      '<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld RULES instructions\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8',
    );

    const { output: output } = setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // New location should have the compact instructions
    const rulesPath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb.md');
    expect(fs.readFileSync(rulesPath, 'utf-8')).toContain('OPEN-ZK-KB:START');

    // Old location should be cleaned up
    const staleContent = fs.readFileSync(staleAgentsPath, 'utf-8');
    expect(staleContent).toContain('# My Rules');
    expect(staleContent).not.toContain('OPEN-ZK-KB:START');

    // Old RULES.md location should also be cleaned up
    if (fs.existsSync(staleRulesPath)) {
      expect(fs.readFileSync(staleRulesPath, 'utf-8')).not.toContain('OPEN-ZK-KB:START');
    }

    // Output should mention the cleanup
    expect(output).toContain('Cleanup:');
    expect(output).toContain('AGENTS.md');
  });

  it('omp install does not touch stale AGENTS.md if it is a symlink', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Simulate a symlinked AGENTS.md with a managed block in the shared target
    const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile,
      '# Shared\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8',
    );
    const staleAgentsPath = path.join(env.homeDir, '.omp', 'agent', 'AGENTS.md');
    fs.mkdirSync(path.dirname(staleAgentsPath), { recursive: true });
    fs.symlinkSync(sharedFile, staleAgentsPath);

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // Shared file must NOT be touched — stale cleanup skips symlinks
    const sharedContent = fs.readFileSync(sharedFile, 'utf-8');
    expect(sharedContent).toContain('OPEN-ZK-KB:START'); // still has the old block
    expect(sharedContent).toContain('# Shared'); // original content preserved

    // rules/open-zk-kb.md should be created correctly
    const rulesPath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb.md');
    expect(fs.readFileSync(rulesPath, 'utf-8')).toContain('OPEN-ZK-KB:START');
  });

  it('doctor detects stale managed block in old OMP AGENTS.md location', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Install normally (goes to rules/open-zk-kb.md)
    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // Manually add a stale block to the old AGENTS.md location
    const staleAgentsPath = path.join(env.homeDir, '.omp', 'agent', 'AGENTS.md');
    fs.writeFileSync(staleAgentsPath,
      '<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nStale\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8',
    );

    const output = setupModule.doctor({ client: 'omp' });
    expect(output).toContain('WARN OMP: stale managed block in');
    expect(output).toContain('AGENTS.md');
  });

  it('doctor --fix removes stale managed block from old OMP AGENTS.md location', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const staleAgentsPath = path.join(env.homeDir, '.omp', 'agent', 'AGENTS.md');
    fs.writeFileSync(staleAgentsPath,
      '# Rules\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nStale\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8',
    );

    const output = setupModule.doctor({ client: 'omp', fix: true });
    expect(output).toContain('FIXED OMP: removed stale managed block');

    const cleaned = fs.readFileSync(staleAgentsPath, 'utf-8');
    expect(cleaned).toContain('# Rules');
    expect(cleaned).not.toContain('OPEN-ZK-KB:START');
  });

  it('omp install injects the slim preflight rule', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const rulesPath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb.md');
    expectSlimAgentDocsBlock(fs.readFileSync(rulesPath, 'utf-8'), true);
  });

  it('omp install creates TTSR enforcement rule alongside main rule', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const ttsrPath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb-enforce.md');
    expect(fs.existsSync(ttsrPath)).toBe(true);

    const content = fs.readFileSync(ttsrPath, 'utf-8');
    // Has TTSR frontmatter
    expect(content).toContain('condition:');
    expect(content).toContain('interruptMode:');
    // Catches false storage claims
    expect(content).toContain('knowledge-store');
  });

  it('omp uninstall removes TTSR enforcement rule', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const ttsrPath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb-enforce.md');
    expect(fs.existsSync(ttsrPath)).toBe(true);

    setupModule.uninstall({ client: 'omp' });
    expect(fs.existsSync(ttsrPath)).toBe(false);
  });

  it('doctor warns on stale TTSR rule content and repairs it with --fix', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const ttsrPath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb-enforce.md');
    // Corrupt the installed rule so it no longer matches the template.
    fs.writeFileSync(ttsrPath, 'stale garbage without enforcement fields\n', 'utf-8');

    const warnOutput = setupModule.doctor({ client: 'omp' });
    expect(warnOutput).toContain('WARN OMP: TTSR enforcement rule needs repair');
    expect(warnOutput).not.toContain('OK OMP: TTSR enforcement rule is healthy');

    const fixOutput = setupModule.doctor({ client: 'omp', fix: true });
    expect(fixOutput).toContain('FIXED OMP: repaired TTSR enforcement rule');

    const repaired = fs.readFileSync(ttsrPath, 'utf-8');
    expect(repaired).toContain('condition:');
    expect(repaired).toContain('interruptMode:');
  });

  it('omp uninstall dry-run detects a dangling TTSR symlink', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const ttsrPath = path.join(env.homeDir, '.omp', 'agent', 'rules', 'open-zk-kb-enforce.md');
    fs.unlinkSync(ttsrPath);
    // Dangling symlink: fs.existsSync follows the link and reports false.
    fs.symlinkSync(path.join(env.homeDir, 'missing-shared-target.md'), ttsrPath);
    expect(fs.existsSync(ttsrPath)).toBe(false);

    const result = setupModule.uninstall({ client: 'omp', dryRun: true });
    expect(result.output).toContain(`Would remove TTSR rule from ${ttsrPath}`);
  });

  it('omp install cleans stale block from symlinked AGENTS.md when injectSharedAgentDocs is true', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Create a shared file with a stale managed block
    const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile,
      '# Shared\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8',
    );
    // Symlink the OMP stale path to the shared file
    const staleAgentsPath = path.join(env.homeDir, '.omp', 'agent', 'AGENTS.md');
    fs.mkdirSync(path.dirname(staleAgentsPath), { recursive: true });
    fs.symlinkSync(sharedFile, staleAgentsPath);

    const { output: output } = setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
      injectSharedAgentDocs: true,
    });

    // Shared file should have the stale block removed
    const sharedContent = fs.readFileSync(sharedFile, 'utf-8');
    expect(sharedContent).toContain('# Shared');
    expect(sharedContent).not.toContain('OPEN-ZK-KB:START');

    // Output should report the cleanup
    expect(output).toContain('Cleanup:');
    expect(output).toContain('AGENTS.md');
  });

  it('omp install warns about stale block in symlinked AGENTS.md when not opted in', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Create a shared file with a stale managed block
    const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile,
      '# Shared\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8',
    );
    const staleAgentsPath = path.join(env.homeDir, '.omp', 'agent', 'AGENTS.md');
    fs.mkdirSync(path.dirname(staleAgentsPath), { recursive: true });
    fs.symlinkSync(sharedFile, staleAgentsPath);

    const { output: output } = setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // Shared file should NOT be touched
    const sharedContent = fs.readFileSync(sharedFile, 'utf-8');
    expect(sharedContent).toContain('OPEN-ZK-KB:START');

    // Output should warn about the stale symlinked block
    expect(output).toContain('stale managed block in symlinked');
    expect(output).toContain('AGENTS.md');
  });

  it('doctor detects stale managed block in symlinked OMP AGENTS.md', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // Create a shared file with a stale managed block, symlinked from the stale path
    const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile,
      '# Shared\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nStale\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8',
    );
    const staleAgentsPath = path.join(env.homeDir, '.omp', 'agent', 'AGENTS.md');
    // Remove existing non-symlink AGENTS.md if install created one
    if (fs.existsSync(staleAgentsPath)) fs.unlinkSync(staleAgentsPath);
    fs.symlinkSync(sharedFile, staleAgentsPath);

    const output = setupModule.doctor({ client: 'omp' });
    expect(output).toContain('WARN OMP: stale managed block in');
    expect(output).toContain('AGENTS.md');
    expect(output).toContain('→'); // symlink indicator
  });

  it('doctor --fix removes stale managed block from symlinked OMP AGENTS.md', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // Create a shared file with a stale managed block, symlinked from the stale path
    const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile,
      '# Shared\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nStale\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8',
    );
    const staleAgentsPath = path.join(env.homeDir, '.omp', 'agent', 'AGENTS.md');
    if (fs.existsSync(staleAgentsPath)) fs.unlinkSync(staleAgentsPath);
    fs.symlinkSync(sharedFile, staleAgentsPath);

    const output = setupModule.doctor({ client: 'omp', fix: true });
    expect(output).toContain('FIXED OMP: removed stale managed block');
    expect(output).toContain('→'); // symlink indicator

    // Shared file should be cleaned
    const cleaned = fs.readFileSync(sharedFile, 'utf-8');
    expect(cleaned).toContain('# Shared');
    expect(cleaned).not.toContain('OPEN-ZK-KB:START');
  });

  it('omp dry-run reports stale symlink skip', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Create a shared file with a stale managed block, symlinked from the stale path
    const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile,
      '# Shared\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8',
    );
    const staleAgentsPath = path.join(env.homeDir, '.omp', 'agent', 'AGENTS.md');
    fs.mkdirSync(path.dirname(staleAgentsPath), { recursive: true });
    fs.symlinkSync(sharedFile, staleAgentsPath);

    const { output: output } = setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
      dryRun: true,
    });

    expect(output).toContain('Would skip stale cleanup');
    expect(output).toContain('AGENTS.md');
  });

  // --- Uninstall: stale cleanup and symlink handling ---

  it('omp uninstall cleans up stale managed blocks from AGENTS.md and RULES.md', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Install first so there's something to uninstall
    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    // Add stale blocks AFTER install (install would clean them during its own stale pass)
    const staleAgentsPath = path.join(env.homeDir, '.omp', 'agent', 'AGENTS.md');
    fs.mkdirSync(path.dirname(staleAgentsPath), { recursive: true });
    fs.writeFileSync(staleAgentsPath,
      '# My Rules\n\n<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld instructions\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8',
    );
    const staleRulesPath = path.join(env.homeDir, '.omp', 'agent', 'RULES.md');
    fs.writeFileSync(staleRulesPath,
      '<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->\nOld RULES instructions\n<!-- OPEN-ZK-KB:END -->\n',
      'utf-8',
    );

    const result = setupModule.uninstall({ client: 'omp' });
    expect(result.status).toBe('uninstalled');

    // AGENTS.md: user content preserved, managed block removed
    const agentsContent = fs.readFileSync(staleAgentsPath, 'utf-8');
    expect(agentsContent).toContain('# My Rules');
    expect(agentsContent).not.toContain('OPEN-ZK-KB:START');

    // RULES.md: was only the managed block, so should be deleted
    if (fs.existsSync(staleRulesPath)) {
      expect(fs.readFileSync(staleRulesPath, 'utf-8')).not.toContain('OPEN-ZK-KB:START');
    }

    // Output should mention the stale cleanup
    expect(result.output).toContain('Stale block removed');
  });

  it('omp uninstall skips stale path shared with another active client', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const staleAgentsPath = path.join(env.homeDir, '.omp', 'agent', 'AGENTS.md');
    fs.mkdirSync(path.dirname(staleAgentsPath), { recursive: true });
    fs.writeFileSync(staleAgentsPath, '# Shared OMP-era rules\n', 'utf-8');

    const opencodeAgentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(opencodeAgentDocsPath), { recursive: true });
    fs.symlinkSync(staleAgentsPath, opencodeAgentDocsPath);

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
      force: true,
      injectSharedAgentDocs: true,
    });
    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const before = fs.readFileSync(staleAgentsPath, 'utf-8');
    expect(before).toContain('OPEN-ZK-KB:START');

    const result = setupModule.uninstall({ client: 'omp' });

    const after = fs.readFileSync(staleAgentsPath, 'utf-8');
    expect(after).toContain('# Shared OMP-era rules');
    expect(after).toContain('OPEN-ZK-KB:START');
    expect(result.output).toContain('shared with another active client');
  });

  describe('--remove-shared-agent-docs CLI flag', () => {
    it('preserves shared symlink targets during CLI uninstall when the flag is absent', async () => {
      const env = createIsolatedInstallEnv();
      const setupModule = await loadFreshSetupModule();

      const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
      fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
      fs.writeFileSync(sharedFile, '# Shared instructions\n', 'utf-8');

      const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
      fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
      fs.symlinkSync(sharedFile, agentDocsPath);

      setupModule.install({
        client: 'opencode',
        serverPath: env.fakeServerPath,
        force: true,
        injectSharedAgentDocs: true,
      });

      const beforeUninstall = fs.readFileSync(sharedFile, 'utf-8');
      expect(beforeUninstall.match(/OPEN-ZK-KB:START/g)?.length).toBe(1);

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => { logs.push(String(message ?? '')); };
      try {
        await setupModule.runSetupCli(['uninstall', '--client', 'opencode']);
      } finally {
        console.log = originalLog;
      }

      const afterUninstall = fs.readFileSync(sharedFile, 'utf-8');
      expect(afterUninstall).toBe(beforeUninstall);
      expect(fs.lstatSync(agentDocsPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(agentDocsPath)).toBe(fs.realpathSync(sharedFile));
      expect(logs.some(line => line.includes('Uninstalled open-zk-kb from OpenCode'))).toBe(true);
    });

    it('removes the managed block from the shared symlink target during CLI uninstall when the flag is present', async () => {
      const env = createIsolatedInstallEnv();
      const setupModule = await loadFreshSetupModule();

      const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
      fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
      fs.writeFileSync(sharedFile, '# Shared instructions\n', 'utf-8');

      const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
      fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
      fs.symlinkSync(sharedFile, agentDocsPath);

      setupModule.install({
        client: 'opencode',
        serverPath: env.fakeServerPath,
        force: true,
        injectSharedAgentDocs: true,
      });
      expect(fs.readFileSync(sharedFile, 'utf-8')).toContain('OPEN-ZK-KB:START');

      const originalLog = console.log;
      console.log = () => {};
      try {
        await setupModule.runSetupCli(['uninstall', '--client', 'opencode', '--remove-shared-agent-docs']);
      } finally {
        console.log = originalLog;
      }

      const afterUninstall = fs.readFileSync(sharedFile, 'utf-8');
      expect(afterUninstall).toBe('# Shared instructions\n');
      expect(fs.lstatSync(agentDocsPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(agentDocsPath)).toBe(fs.realpathSync(sharedFile));
    });
  });

  it('uninstall skips symlinked agent docs and reports in result', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Create a shared file with a managed block
    const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile, '# Shared\n', 'utf-8');

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.symlinkSync(sharedFile, agentDocsPath);

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
      force: true,
      injectSharedAgentDocs: true,
    });
    expect(fs.readFileSync(sharedFile, 'utf-8')).toContain('OPEN-ZK-KB:START');

    // Uninstall without removeSharedAgentDocs — should skip the symlinked file
    const result = setupModule.uninstall({ client: 'opencode' });
    expect(result.status).toBe('uninstalled');
    expect(result.agentDocsSkippedSymlink).toBe(fs.realpathSync(sharedFile));

    // Shared file should still have the block
    const sharedContent = fs.readFileSync(sharedFile, 'utf-8');
    expect(sharedContent).toContain('OPEN-ZK-KB:START');
  });

  it('uninstall removes symlinked agent docs when removeSharedAgentDocs is true', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile, '# Shared\n', 'utf-8');

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.symlinkSync(sharedFile, agentDocsPath);

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
      force: true,
      injectSharedAgentDocs: true,
    });

    const result = setupModule.uninstall({ client: 'opencode', removeSharedAgentDocs: true });
    expect(result.status).toBe('uninstalled');
    expect(result.agentDocsSkippedSymlink).toBeNull();

    // Shared file should have the block removed but user content preserved
    const sharedContent = fs.readFileSync(sharedFile, 'utf-8');
    expect(sharedContent).toContain('# Shared');
    expect(sharedContent).not.toContain('OPEN-ZK-KB:START');
  });

  it('uninstall dry-run reports symlink skip and stale paths', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Set up symlinked agent docs
    const sharedFile = path.join(env.homeDir, '.agents', 'AGENTS.md');
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile, '# Shared\n', 'utf-8');

    const agentDocsPath = path.join(env.xdgConfigHome, 'opencode', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentDocsPath), { recursive: true });
    fs.symlinkSync(sharedFile, agentDocsPath);

    setupModule.install({
      client: 'opencode',
      serverPath: env.fakeServerPath,
      force: true,
      injectSharedAgentDocs: true,
    });

    const result = setupModule.uninstall({ client: 'opencode', dryRun: true });
    expect(result.status).toBe('dry-run');
    expect(result.agentDocsSkippedSymlink).toBe(fs.realpathSync(sharedFile));
    expect(result.output).toContain('skipped');
    expect(result.output).toContain('symlinked');
  });

  it('uninstall returns not-installed for unconfigured client', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    // Create config file but without open-zk-kb entry
    const configPath = path.join(env.xdgConfigHome, 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{}', 'utf-8');

    const result = setupModule.uninstall({ client: 'opencode' });
    expect(result.status).toBe('not-installed');
  });

  it('uninstall result includes per-client labels', async () => {
    const env = createIsolatedInstallEnv();
    const setupModule = await loadFreshSetupModule();

    setupModule.install({
      client: 'omp',
      serverPath: env.fakeServerPath,
      force: true,
    });

    const result = setupModule.uninstall({ client: 'omp' });
    expect(result.status).toBe('uninstalled');
    // OMP uses "Rule:" label
    expect(result.details.some(d => d.startsWith('Rule:'))).toBe(true);
  });
});
