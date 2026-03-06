import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTestHarness, cleanupTestHarness } from './harness.js';
import type { TestContext } from './harness.js';

interface EnvSnapshot {
  HOME?: string;
  XDG_CONFIG_HOME?: string;
  XDG_DATA_HOME?: string;
}

describe('config.ts', () => {
  let ctx: TestContext;
  let envSnapshot: EnvSnapshot;
  const tempDirs: string[] = [];

  beforeEach(() => {
    ctx = createTestHarness();
    envSnapshot = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    };
  });

  afterEach(() => {
    cleanupTestHarness(ctx);

    if (envSnapshot.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = envSnapshot.HOME;
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

  function createIsolatedConfigHome(): { rootDir: string; configPath: string; dataDir: string; homeDir: string } {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-config-test-'));
    const configDir = path.join(rootDir, 'xdg-config', 'open-zk-kb');
    const dataDir = path.join(rootDir, 'xdg-data');
    const homeDir = path.join(rootDir, 'home');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    tempDirs.push(rootDir);

    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = path.join(rootDir, 'xdg-config');
    process.env.XDG_DATA_HOME = dataDir;

    return {
      rootDir,
      configPath: path.join(configDir, 'config.yaml'),
      dataDir,
      homeDir,
    };
  }

  async function loadFreshConfigModule() {
    return import(`../src/config.js?test=${Date.now()}-${Math.random()}`);
  }

  it('returns defaults when config file does not exist', async () => {
    const isolated = createIsolatedConfigHome();
    const configModule = await loadFreshConfigModule();

    const cfg = configModule.getConfig();

    expect(cfg.logLevel).toBe('INFO');
    expect(cfg.vault).toBe(path.join(isolated.dataDir, 'open-zk-kb'));
    expect(cfg.lifecycle.reviewAfterDays).toBe(14);
    expect(cfg.lifecycle.promotionThreshold).toBe(2);
    expect(cfg.lifecycle.exemptKinds).toEqual(['personalization', 'decision']);
  });

  it('reads vault path from YAML config', async () => {
    const isolated = createIsolatedConfigHome();
    const customVault = path.join(isolated.rootDir, 'custom-vault');
    fs.writeFileSync(isolated.configPath, `vault: ${customVault}\n`, 'utf-8');

    const configModule = await loadFreshConfigModule();
    const cfg = configModule.getConfig();

    expect(cfg.vault).toBe(customVault);
  });

  it('falls back to default values for missing keys in partial config', async () => {
    const isolated = createIsolatedConfigHome();
    fs.writeFileSync(isolated.configPath, 'lifecycle:\n  reviewAfterDays: 30\n', 'utf-8');

    const configModule = await loadFreshConfigModule();
    const cfg = configModule.getConfig();

    expect(cfg.lifecycle.reviewAfterDays).toBe(30);
    expect(cfg.lifecycle.promotionThreshold).toBe(2);
    expect(cfg.lifecycle.exemptKinds).toEqual(['personalization', 'decision']);
    expect(cfg.vault).toBe(path.join(isolated.dataDir, 'open-zk-kb'));
  });

  it('handles malformed YAML by returning defaults', async () => {
    const isolated = createIsolatedConfigHome();
    fs.writeFileSync(isolated.configPath, 'lifecycle: [unclosed\n', 'utf-8');

    const configModule = await loadFreshConfigModule();
    const cfg = configModule.getConfig();

    expect(cfg.logLevel).toBe('INFO');
    expect(cfg.vault).toBe(path.join(isolated.dataDir, 'open-zk-kb'));
    expect(cfg.lifecycle.reviewAfterDays).toBe(14);
  });

  it('returns null from getOpenCodeConfig when section is missing', async () => {
    const isolated = createIsolatedConfigHome();
    fs.writeFileSync(isolated.configPath, 'logLevel: WARN\n', 'utf-8');

    const configModule = await loadFreshConfigModule();
    const opencodeConfig = configModule.getOpenCodeConfig();

    expect(opencodeConfig).toBeNull();
  });

  it('returns opencode section from getOpenCodeConfig when present', async () => {
    const isolated = createIsolatedConfigHome();
    fs.writeFileSync(
      isolated.configPath,
      [
        'opencode:',
        '  capture:',
        '    auto: true',
        '    model: openai/gpt-4o-mini',
        '  injection:',
        '    enabled: true',
        '    max_notes: 5',
        '',
      ].join('\n'),
      'utf-8'
    );

    const configModule = await loadFreshConfigModule();
    const opencodeConfig = configModule.getOpenCodeConfig();

    expect(opencodeConfig).not.toBeNull();
    expect(opencodeConfig?.capture?.auto).toBe(true);
    expect(opencodeConfig?.capture?.model).toBe('openai/gpt-4o-mini');
    expect(opencodeConfig?.injection?.enabled).toBe(true);
    expect(opencodeConfig?.injection?.max_notes).toBe(5);
  });
});
