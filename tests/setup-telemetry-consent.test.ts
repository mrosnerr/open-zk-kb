import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { _resetConfigCache } from '../src/config.js';

/**
 * Focused coverage of the installer telemetry consent state machine
 * (OpenSpec add-posthog-telemetry tasks 3.1-3.4):
 *
 *  - 3.1 Interactive acceptance persists telemetry.enabled/share only after a
 *        successful installation; a failed installation never persists it.
 *  - 3.2 Decline and cancellation keep disabled defaults without creating or
 *        rewriting config solely to persist defaults.
 *  - 3.3 --yes and non-interactive (no TTY) installs skip the prompt and never opt in.
 *  - 3.4 --no-telemetry skips the prompt and disables an existing
 *        enabled/shared configuration.
 *
 * The setup module captures XDG paths at import time, so every test sets the
 * XDG/HOME environment before importing a fresh setup module instance.
 * The @clack/prompts module is mocked so the interactive prompt can be driven
 * deterministically without a TTY; the mock is contained to this test file
 * (bun runs each test file in its own process).
 */

const EXAMPLE_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'templates',
  'install',
  'config.example.yaml',
);

const CANCEL = Symbol('telemetry-prompt-cancel');

interface PromptCall {
  message: string;
  initialValue: boolean;
}

/** Mutable control state shared with the mocked @clack/prompts module. */
const promptState: { answer: boolean | symbol; calls: PromptCall[]; selected: string[] } = {
  answer: true,
  calls: [],
  selected: [],
};

function installClackMock(): void {
  mock.module('@clack/prompts', () => ({
    confirm: async (opts: PromptCall) => {
      promptState.calls.push(opts);
      return promptState.answer;
    },
    isCancel: (value: unknown) => value === CANCEL,
    cancel: () => {},
    intro: () => {},
    outro: () => {},
    log: { info: () => {}, warn: () => {}, success: () => {}, error: () => {}, message: () => {} },
    groupMultiselect: async () => promptState.selected,
    select: async () => 'skip',
    text: async () => '',
  }));
}

interface IsolatedEnv {
  rootDir: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  homeDir: string;
  fakeServerPath: string;
}

/** Create a fully isolated home set and point XDG/HOME env vars at it. */
function createIsolatedEnv(): IsolatedEnv {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-telemetry-consent-'));
  const xdgConfigHome = path.join(rootDir, 'xdg-config');
  const xdgDataHome = path.join(rootDir, 'xdg-data');
  const homeDir = path.join(rootDir, 'home');
  const fakeServerPath = path.join(rootDir, 'dist', 'mcp-server.js');

  fs.mkdirSync(path.dirname(fakeServerPath), { recursive: true });
  fs.writeFileSync(fakeServerPath, 'export {};\n', 'utf-8');
  fs.mkdirSync(xdgConfigHome, { recursive: true });
  fs.mkdirSync(xdgDataHome, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  process.env.XDG_DATA_HOME = xdgDataHome;
  process.env.HOME = homeDir;

  return { rootDir, xdgConfigHome, xdgDataHome, homeDir, fakeServerPath };
}

interface EnvSnapshot {
  XDG_CONFIG_HOME?: string;
  XDG_DATA_HOME?: string;
  HOME?: string;
}

const ORIGINAL_STDIN_TTY = process.stdin.isTTY;

function setStdinTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
}

/** Import the setup module fresh so it reads the current XDG env at module scope. */
async function loadFreshSetupModule() {
  return import(`../src/setup.js?test=${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
}

function openZkConfigPath(env: IsolatedEnv): string {
  return path.join(env.xdgConfigHome, 'open-zk-kb', 'config.yaml');
}

/** Parse a YAML mapping, throwing on non-mapping shapes.
 *  Comments-only files parse to null and are treated as an empty mapping,
 *  matching writeTelemetryConfig's handling of such configs. */
function readConfigYaml(configPath: string): Record<string, unknown> {
  const parsed = YAML.parse(fs.readFileSync(configPath, 'utf-8'));
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected a YAML mapping at ${configPath}`);
  }
  return parsed as Record<string, unknown>;
}

function readTelemetry(configPath: string): Record<string, unknown> {
  const doc = readConfigYaml(configPath);
  const telemetry = doc.telemetry;
  if (!telemetry || typeof telemetry !== 'object' || Array.isArray(telemetry)) {
    throw new Error(`Expected a telemetry mapping in ${configPath}`);
  }
  return telemetry as Record<string, unknown>;
}

function writeConfig(env: IsolatedEnv, content: string): void {
  const configPath = openZkConfigPath(env);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, content, 'utf-8');
}

describe('setup telemetry consent (install prompt)', () => {
  let env: IsolatedEnv;
  let envSnapshot: EnvSnapshot;
  const tempDirs: string[] = [];

  beforeEach(() => {
    // Snapshot BEFORE mutating env so afterEach restores the original values.
    envSnapshot = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      HOME: process.env.HOME,
    };
    env = createIsolatedEnv();
    tempDirs.push(env.rootDir);
    promptState.answer = true;
    promptState.calls = [];
    promptState.selected = [];
    // config.ts caches the parsed YAML; drop it so this test's fresh env is read.
    _resetConfigCache();
  });

  afterEach(() => {
    // Restore env vars
    if (envSnapshot.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = envSnapshot.XDG_CONFIG_HOME;
    if (envSnapshot.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = envSnapshot.XDG_DATA_HOME;
    if (envSnapshot.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = envSnapshot.HOME;
    setStdinTTY(ORIGINAL_STDIN_TTY === true ? true : undefined);

    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // ── 3.1 Interactive acceptance persists only after installation succeeds ──

  it('accepts telemetry: writes enabled/share true only after a successful install', async () => {
    installClackMock();
    setStdinTTY(true);
    promptState.answer = true;

    const originalFetch = globalThis.fetch;
    const fetchCalls: unknown[][] = [];
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalls.push(args);
      throw new Error('setup must not make network requests');
    }) as typeof fetch;
    try {
      const setup = await loadFreshSetupModule();
      await setup.runSetupCli(['install', '--client', 'opencode', '--server-path', env.fakeServerPath]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The prompt was shown with Yes preselected and explained the destination/docs.
    expect(promptState.calls).toHaveLength(1);
    expect(promptState.calls[0].initialValue).toBe(true);
    expect(promptState.calls[0].message).toContain('PostHog EU Cloud');
    expect(promptState.calls[0].message).toContain('docs/telemetry.md');

    // The opt-in is persisted only now that installation succeeded...
    const telemetry = readTelemetry(openZkConfigPath(env));
    expect(telemetry.enabled).toBe(true);
    expect(telemetry.share).toBe(true);

    // ...and no PostHog request occurred during installation.
    expect(fetchCalls).toHaveLength(0);
  });

  it('does not persist acceptance when installation fails', async () => {
    installClackMock();
    setStdinTTY(true);
    promptState.answer = true;

    const setup = await loadFreshSetupModule();
    const missingServer = path.join(env.rootDir, 'dist', 'missing-server.js');
    await expect(
      setup.runSetupCli(['install', '--client', 'opencode', '--server-path', missingServer]),
    ).rejects.toThrow(/Server not found/);

    // The user accepted (prompt shown before install) but nothing was persisted.
    expect(promptState.calls).toHaveLength(1);
    expect(promptState.calls[0].initialValue).toBe(true);
    expect(fs.existsSync(openZkConfigPath(env))).toBe(false);
  });

  it('does not persist acceptance when one selected install succeeds and another fails', async () => {
    installClackMock();
    setStdinTTY(true);
    promptState.answer = true;
    promptState.selected = ['opencode', 'cursor'];

    const cursorConfigPath = path.join(env.homeDir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursorConfigPath), { recursive: true });
    fs.writeFileSync(cursorConfigPath, '{ invalid json', 'utf-8');

    const setup = await loadFreshSetupModule();
    const previousExitCode = process.exitCode;
    try {
      await setup.runSetupCli(['install', '--server-path', env.fakeServerPath]);

      expect(fs.existsSync(path.join(env.xdgConfigHome, 'opencode', 'opencode.json'))).toBe(true);
      expect(fs.readFileSync(cursorConfigPath, 'utf-8')).toBe('{ invalid json');
      expect(fs.readFileSync(openZkConfigPath(env), 'utf-8')).toBe(
        fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf-8'),
      );
    } finally {
      process.exitCode = previousExitCode ?? 0;
    }
  });

  // ── 3.2 Decline and cancellation preserve safe defaults ──

  it('declining keeps disabled defaults and does not rewrite the seeded config', async () => {
    installClackMock();
    setStdinTTY(true);
    promptState.answer = false;

    const setup = await loadFreshSetupModule();
    await setup.runSetupCli(['install', '--client', 'opencode', '--server-path', env.fakeServerPath]);

    expect(promptState.calls).toHaveLength(1);
    // install() seeds the example config; declining must not rewrite it.
    expect(fs.readFileSync(openZkConfigPath(env), 'utf-8')).toBe(
      fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf-8'),
    );
    // Neither flag is present (absent resolves to disabled runtime defaults).
    const doc = readConfigYaml(openZkConfigPath(env));
    expect(doc.telemetry).toBeUndefined();
    // Installation itself still succeeds.
    expect(fs.existsSync(path.join(env.xdgConfigHome, 'opencode', 'opencode.json'))).toBe(true);
  });

  it('cancelling continues installation without an opt-in or config rewrite', async () => {
    installClackMock();
    setStdinTTY(true);
    promptState.answer = CANCEL;

    const setup = await loadFreshSetupModule();
    await setup.runSetupCli(['install', '--client', 'opencode', '--server-path', env.fakeServerPath]);

    expect(promptState.calls).toHaveLength(1);
    expect(fs.readFileSync(openZkConfigPath(env), 'utf-8')).toBe(
      fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf-8'),
    );
    // Cancellation does not block installation.
    expect(fs.existsSync(path.join(env.xdgConfigHome, 'opencode', 'opencode.json'))).toBe(true);
  });

  it('does not prompt or overwrite when telemetry.share is already explicitly configured', async () => {
    installClackMock();
    setStdinTTY(true);
    promptState.answer = true; // would accept if prompted

    writeConfig(
      env,
      [
        'logLevel: DEBUG',
        'telemetry:',
        '  enabled: true',
        '  share: false',
        '',
      ].join('\n'),
    );
    const before = fs.readFileSync(openZkConfigPath(env), 'utf-8');

    const setup = await loadFreshSetupModule();
    await setup.runSetupCli(['install', '--client', 'opencode', '--server-path', env.fakeServerPath]);

    // No prompt was shown and the explicit choice was left untouched.
    expect(promptState.calls).toHaveLength(0);
    expect(fs.readFileSync(openZkConfigPath(env), 'utf-8')).toBe(before);
  });

  // ── 3.3 --yes and non-interactive installs never opt in ──

  it('--yes skips the prompt and does not opt in', async () => {
    installClackMock();
    setStdinTTY(true); // interactive TTY, but --yes overrides
    promptState.answer = true;

    const setup = await loadFreshSetupModule();
    await setup.runSetupCli([
      'install',
      '--client',
      'opencode',
      '--server-path',
      env.fakeServerPath,
      '--yes',
    ]);

    expect(promptState.calls).toHaveLength(0);
    expect(fs.readFileSync(openZkConfigPath(env), 'utf-8')).toBe(
      fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf-8'),
    );
  });

  it('non-interactive install (no TTY) skips the prompt and does not opt in', async () => {
    installClackMock();
    setStdinTTY(undefined);
    promptState.answer = true;

    const setup = await loadFreshSetupModule();
    await setup.runSetupCli(['install', '--client', 'opencode', '--server-path', env.fakeServerPath]);

    expect(promptState.calls).toHaveLength(0);
    expect(fs.readFileSync(openZkConfigPath(env), 'utf-8')).toBe(
      fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf-8'),
    );
  });

  // ── 3.4 --no-telemetry is an explicit opt-out ──

  it('--no-telemetry disables an existing enabled/share config without prompting', async () => {
    installClackMock();
    setStdinTTY(true); // interactive TTY, but --no-telemetry suppresses the prompt
    promptState.answer = true;

    writeConfig(
      env,
      [
        'logLevel: DEBUG',
        'telemetry:',
        '  enabled: true',
        '  share: true',
        '  id: existing-install-id',
        '',
      ].join('\n'),
    );

    const setup = await loadFreshSetupModule();
    await setup.runSetupCli([
      'install',
      '--client',
      'opencode',
      '--server-path',
      env.fakeServerPath,
      '--no-telemetry',
    ]);

    expect(promptState.calls).toHaveLength(0);
    const telemetry = readTelemetry(openZkConfigPath(env));
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.share).toBe(false);
    // Unrelated settings and the installation id are preserved.
    expect(readConfigYaml(openZkConfigPath(env)).logLevel).toBe('DEBUG');
    expect(telemetry.id).toBe('existing-install-id');
  });

  it('--no-telemetry without an existing config writes nothing and never prompts', async () => {
    installClackMock();
    setStdinTTY(true);
    promptState.answer = true;

    const setup = await loadFreshSetupModule();
    await setup.runSetupCli([
      'install',
      '--client',
      'opencode',
      '--server-path',
      env.fakeServerPath,
      '--no-telemetry',
    ]);

    expect(promptState.calls).toHaveLength(0);
    // Disabled runtime defaults are sufficient; install() only seeds the
    // commented example config, which leaves telemetry disabled.
    expect(fs.readFileSync(openZkConfigPath(env), 'utf-8')).toBe(
      fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf-8'),
    );
  });
});
