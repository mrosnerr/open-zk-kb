import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const smokeScript = path.resolve(import.meta.dir, 'docker/smoke-test.sh');
const tempDirs: string[] = [];
const originalEnv = {
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  OPEN_ZK_KB_SMOKE_TEST: process.env.OPEN_ZK_KB_SMOKE_TEST,
  OPEN_ZK_KB_SMOKE_SANDBOX_ROOT: process.env.OPEN_ZK_KB_SMOKE_SANDBOX_ROOT,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function parseKeyValues(output: string): Record<string, string> {
  return Object.fromEntries(
    output.trim().split('\n').map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
}

describe('destructive smoke-test safety', () => {
  it('replaces inherited HOME and XDG paths before any destructive operation', () => {
    const fixtureRoot = createTempDir('kb-smoke-host-');
    const fakeRealHome = path.join(fixtureRoot, 'real-home');
    const fakeRealVault = path.join(fakeRealHome, '.local', 'share', 'open-zk-kb');
    const tempParent = path.join(fixtureRoot, 'temp-parent');
    const marker = path.join(fakeRealVault, 'must-survive.md');
    fs.mkdirSync(fakeRealVault, { recursive: true });
    fs.mkdirSync(tempParent, { recursive: true });
    fs.writeFileSync(marker, 'production knowledge');

    const result = Bun.spawnSync(['bash', smokeScript, '--verify-sandbox'], {
      env: {
        ...process.env,
        HOME: fakeRealHome,
        TMPDIR: tempParent,
        XDG_CONFIG_HOME: path.join(fakeRealHome, 'real-config'),
        XDG_DATA_HOME: path.join(fakeRealHome, 'real-data'),
        XDG_STATE_HOME: path.join(fakeRealHome, 'real-state'),
        XDG_CACHE_HOME: path.join(fakeRealHome, 'real-cache'),
        XDG_RUNTIME_DIR: path.join(fakeRealHome, 'real-runtime'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(marker, 'utf8')).toBe('production knowledge');

    const values = parseKeyValues(result.stdout.toString());
    const sandboxRoot = values.SMOKE_SANDBOX_ROOT;
    expect(sandboxRoot).toStartWith(`${fs.realpathSync(tempParent)}${path.sep}`);
    for (const key of [
      'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
      'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'NPM_CONFIG_CACHE',
      'NPM_CONFIG_PREFIX', 'NPM_CONFIG_USERCONFIG', 'BUN_INSTALL',
      'BUN_INSTALL_CACHE_DIR', 'GIT_CONFIG_GLOBAL',
    ]) {
      expect(values[key]).toStartWith(`${sandboxRoot}${path.sep}`);
      expect(values[key]).not.toStartWith(`${fs.realpathSync(fakeRealHome)}${path.sep}`);
    }
  });

  it('seeds the model cache only inside the private sandbox', () => {
    const fixtureRoot = createTempDir('kb-smoke-model-cache-');
    const fakeRealHome = path.join(fixtureRoot, 'real-home');
    const tempParent = path.join(fixtureRoot, 'temp-parent');
    const seedDir = path.join(fixtureRoot, 'cache-seed', 'all-MiniLM-L6-v2');
    const seedMarker = path.join(seedDir, 'model.json');
    fs.mkdirSync(fakeRealHome, { recursive: true });
    fs.mkdirSync(tempParent, { recursive: true });
    fs.mkdirSync(seedDir, { recursive: true });
    fs.writeFileSync(seedMarker, '{"model":"fixture"}');

    const result = Bun.spawnSync(['bash', smokeScript, '--verify-sandbox'], {
      env: {
        ...process.env,
        HOME: fakeRealHome,
        TMPDIR: tempParent,
        OPEN_ZK_KB_MODEL_CACHE_SEED: seedDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(seedMarker, 'utf8')).toBe('{"model":"fixture"}');
    const values = parseKeyValues(result.stdout.toString());
    expect(values.MODEL_CACHE_SEEDED).toBe('true');
    expect(values.MODEL_CACHE_DIR).toStartWith(`${values.SMOKE_SANDBOX_ROOT}${path.sep}`);

    fs.symlinkSync(fakeRealHome, path.join(seedDir, 'outside-link'));
    const unsafeResult = Bun.spawnSync(['bash', smokeScript, '--verify-sandbox'], {
      env: {
        ...process.env,
        HOME: fakeRealHome,
        TMPDIR: tempParent,
        OPEN_ZK_KB_MODEL_CACHE_SEED: seedDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(unsafeResult.exitCode).toBe(1);
    expect(unsafeResult.stderr.toString()).toContain('source contains symlinks');
  });

  it('refuses to run the destructive suite on an unmarked host', () => {
    const fixtureRoot = createTempDir('kb-smoke-unmarked-host-');
    const fakeRealHome = path.join(fixtureRoot, 'real-home');
    const fakeRealVault = path.join(fakeRealHome, '.local', 'share', 'open-zk-kb');
    const marker = path.join(fakeRealVault, 'must-survive.md');
    fs.mkdirSync(fakeRealVault, { recursive: true });
    fs.writeFileSync(marker, 'production knowledge');

    const env = { ...process.env, HOME: fakeRealHome };
    delete env.OPEN_ZK_KB_EPHEMERAL_SMOKE;
    const result = Bun.spawnSync(['bash', smokeScript], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('REFUSING TO RUN destructive smoke tests');
    expect(fs.readFileSync(marker, 'utf8')).toBe('production knowledge');
  });

  it('refuses an inherited temporary directory inside the real home', () => {
    const fixtureRoot = createTempDir('kb-smoke-hostile-tmp-');
    const fakeRealHome = path.join(fixtureRoot, 'real-home');
    const fakeRealVault = path.join(fakeRealHome, '.local', 'share', 'open-zk-kb');
    const hostileTemp = path.join(fakeRealHome, 'tmp');
    const marker = path.join(fakeRealVault, 'must-survive.md');
    fs.mkdirSync(fakeRealVault, { recursive: true });
    fs.mkdirSync(hostileTemp, { recursive: true });
    fs.writeFileSync(marker, 'production knowledge');

    const result = Bun.spawnSync(['bash', smokeScript, '--verify-sandbox'], {
      env: { ...process.env, HOME: fakeRealHome, TMPDIR: hostileTemp },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('smoke sandbox resolved inside user data');
    expect(fs.readFileSync(marker, 'utf8')).toBe('production knowledge');
    expect(fs.readdirSync(hostileTemp)).toEqual([]);
  });

  it('routes every recursive deletion through the sandbox guard', () => {
    const script = fs.readFileSync(smokeScript, 'utf8');
    const recursiveDeletes = script.split('\n').filter((line) => /\brm -rf\b/.test(line));

    expect(recursiveDeletes).toEqual([
      '    rm -rf -- "$target"',
      '    rm -rf -- "$SMOKE_SANDBOX_ROOT"',
    ]);
    expect(script).not.toContain('git checkout package.json');
    expect(script).not.toContain('VAULT_PATH="$HOME/.local/share/open-zk-kb"');
  });

  it('uses the isolated temporary directory for model smoke fixtures', () => {
    const modelSmokeScript = fs.readFileSync(
      path.resolve(import.meta.dir, 'docker/model-smoke-test.ts'),
      'utf8',
    );

    expect(modelSmokeScript).not.toContain("mkdtempSync('/tmp/");
    expect(modelSmokeScript).toContain('process.env.TMPDIR || os.tmpdir()');
  });

  it('requires TLS verification for model downloads', () => {
    for (const relativePath of [
      '../.github/workflows/ci.yml',
      'docker/Dockerfile',
      'docker/smoke-test.sh',
    ]) {
      const source = fs.readFileSync(path.resolve(import.meta.dir, relativePath), 'utf8');
      expect(source).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    }
  });

  it('makes setup refuse smoke-test deletion outside the marked sandbox', async () => {
    const fixtureRoot = createTempDir('kb-smoke-setup-refusal-');
    const sandboxRoot = path.join(fixtureRoot, 'sandbox');
    const outsideDataHome = path.join(fixtureRoot, 'outside-data');
    const outsideVault = path.join(outsideDataHome, 'open-zk-kb');
    const marker = path.join(outsideVault, 'must-survive.md');
    fs.mkdirSync(sandboxRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sandboxRoot, '.open-zk-kb-smoke-sandbox'),
      'open-zk-kb destructive smoke-test sandbox',
    );
    fs.mkdirSync(outsideVault, { recursive: true });
    fs.writeFileSync(marker, 'production knowledge');

    process.env.HOME = path.join(fixtureRoot, 'home');
    process.env.XDG_CONFIG_HOME = path.join(fixtureRoot, 'config');
    process.env.XDG_DATA_HOME = outsideDataHome;
    process.env.OPEN_ZK_KB_SMOKE_TEST = '1';
    process.env.OPEN_ZK_KB_SMOKE_SANDBOX_ROOT = sandboxRoot;
    const cursorConfig = path.join(process.env.HOME, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursorConfig), { recursive: true });
    fs.writeFileSync(cursorConfig, '{"mcpServers":{"open-zk-kb":{"command":"bun"}}}');

    const setup = await import(`../src/setup.js?smoke-refusal=${Date.now()}-${Math.random()}`);
    for (const options of [
      { client: 'cursor' as const, removeVault: true, confirm: false },
      { client: 'cursor' as const, removeVault: true, confirm: true, dryRun: true },
      { client: 'cursor' as const, removeVault: true, confirm: true },
    ]) {
      expect(() => setup.uninstall(options))
        .toThrow('Refusing vault deletion outside smoke-test sandbox');
    }
    expect(fs.readFileSync(marker, 'utf8')).toBe('production knowledge');
  });

  it('allows setup to delete only a vault inside the marked sandbox', async () => {
    const sandboxRoot = createTempDir('kb-smoke-setup-allowed-');
    const dataHome = path.join(sandboxRoot, 'home', '.local', 'share');
    const vault = path.join(dataHome, 'open-zk-kb');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(
      path.join(sandboxRoot, '.open-zk-kb-smoke-sandbox'),
      'open-zk-kb destructive smoke-test sandbox',
    );
    fs.writeFileSync(path.join(vault, 'fixture.md'), 'test knowledge');

    process.env.HOME = path.join(sandboxRoot, 'home');
    process.env.XDG_CONFIG_HOME = path.join(sandboxRoot, 'home', '.config');
    process.env.XDG_DATA_HOME = dataHome;
    process.env.OPEN_ZK_KB_SMOKE_TEST = '1';
    process.env.OPEN_ZK_KB_SMOKE_SANDBOX_ROOT = sandboxRoot;
    const cursorConfig = path.join(process.env.HOME, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursorConfig), { recursive: true });
    fs.writeFileSync(cursorConfig, '{"mcpServers":{"open-zk-kb":{"command":"bun"}}}');

    const setup = await import(`../src/setup.js?smoke-allowed=${Date.now()}-${Math.random()}`);
    setup.uninstall({ client: 'cursor', removeVault: true, confirm: true });
    expect(fs.existsSync(vault)).toBe(false);
  });
});
