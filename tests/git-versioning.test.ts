import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitVersioning, createGitVersioning, buildCommitMessage } from '../src/git-versioning.js';
import type { PendingOp } from '../src/git-versioning.js';
import type { VersioningConfig } from '../src/types.js';

const DEBOUNCE_MS = 75;
const ENABLED_CONFIG: VersioningConfig = { enabled: true, debounceMs: DEBOUNCE_MS };
const DISABLED_CONFIG: VersioningConfig = { enabled: false, debounceMs: DEBOUNCE_MS };
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'open-zk-kb-test',
  GIT_AUTHOR_EMAIL: 'open-zk-kb-test@local',
  GIT_COMMITTER_NAME: 'open-zk-kb-test',
  GIT_COMMITTER_EMAIL: 'open-zk-kb-test@local',
};

describe('git-versioning.ts', () => {
  let tempDirs: string[];
  let versioning: GitVersioning | null;

  beforeEach(() => {
    tempDirs = [];
    versioning = null;
  });

  afterEach(() => {
    versioning?.shutdownSync();
    versioning = null;

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  function createVault(): string {
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-git-versioning-test-'));
    tempDirs.push(vaultPath);
    return vaultPath;
  }

  function writeVaultFile(vaultPath: string, relativePath: string, content: string): void {
    const filePath = path.join(vaultPath, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  function appendVaultFile(vaultPath: string, relativePath: string, content: string): void {
    fs.appendFileSync(path.join(vaultPath, relativePath), content, 'utf-8');
  }

  function git(vaultPath: string, args: string[]): Bun.SpawnSyncReturns<Uint8Array, Uint8Array> {
    return Bun.spawnSync(['git', ...args], {
      cwd: vaultPath,
      env: { ...process.env, ...GIT_ENV },
    });
  }

  function gitLog(vaultPath: string): string {
    const result = Bun.spawnSync(['git', 'log', '--oneline'], { cwd: vaultPath });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  }

  function gitFullLog(vaultPath: string): string {
    const result = git(vaultPath, ['log', '--format=%B']);
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  }

  function gitStatus(vaultPath: string): string {
    const result = git(vaultPath, ['status', '--porcelain']);
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  }

  function commitCount(vaultPath: string): number {
    const result = git(vaultPath, ['rev-list', '--count', 'HEAD']);
    expect(result.exitCode).toBe(0);
    return Number(result.stdout.toString().trim());
  }

  async function waitForLog(vaultPath: string, expected: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const log = gitLog(vaultPath);
      if (log.includes(expected)) return log;
      await Bun.sleep(25);
    }

    return gitLog(vaultPath);
  }

  async function waitForCommitCount(vaultPath: string, expected: number): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const count = commitCount(vaultPath);
      if (count === expected) return count;
      await Bun.sleep(25);
    }

    return commitCount(vaultPath);
  }

  function initManualRepo(vaultPath: string): void {
    expect(git(vaultPath, ['init']).exitCode).toBe(0);
  }

  function manualCommit(vaultPath: string, message: string): void {
    expect(git(vaultPath, ['add', '-A']).exitCode).toBe(0);
    expect(git(vaultPath, ['commit', '-m', message]).exitCode).toBe(0);
  }

  function pendingOp(overrides: Partial<PendingOp> = {}): PendingOp {
    return {
      op: 'store',
      noteId: '2026010101010100',
      title: 'Test Note',
      kind: 'observation',
      ...overrides,
    };
  }

  it('init() creates a .git directory and .gitignore', async () => {
    const vaultPath = createVault();
    versioning = new GitVersioning(vaultPath, ENABLED_CONFIG);

    await versioning.init();

    expect(fs.existsSync(path.join(vaultPath, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(vaultPath, '.gitignore'))).toBe(true);
    expect(versioning.isActive).toBe(true);
  });

  it('init() makes an initial commit with existing files', async () => {
    const vaultPath = createVault();
    writeVaultFile(vaultPath, '2026010101010100-existing.md', '# Existing\n');
    versioning = new GitVersioning(vaultPath, ENABLED_CONFIG);

    await versioning.init();

    const log = gitLog(vaultPath);
    expect(log).toContain('[init] Knowledge base');
    expect(commitCount(vaultPath)).toBe(1);
  });

  it('recordOp() commits after the debounce window', async () => {
    const vaultPath = createVault();
    versioning = createGitVersioning(vaultPath, ENABLED_CONFIG);
    await versioning.init();
    writeVaultFile(vaultPath, '2026010101010100-debounced.md', '# Debounced\n');

    versioning.recordOp(pendingOp({ title: 'Debounced' }));
    await Bun.sleep(DEBOUNCE_MS + 50);

    const log = await waitForLog(vaultPath, 'Store observation: "Debounced"');
    expect(log).toContain('Store observation: "Debounced"');
  });

  it('recordImmediate() commits without waiting for debounce', async () => {
    const vaultPath = createVault();
    versioning = new GitVersioning(vaultPath, ENABLED_CONFIG);
    await versioning.init();
    writeVaultFile(vaultPath, '2026010101010100-immediate.md', '# Immediate\n');

    await versioning.recordImmediate(pendingOp({ title: 'Immediate' }));

    const log = gitLog(vaultPath);
    expect(log).toContain('Store observation: "Immediate"');
  });

  it('preCommit() creates a snapshot commit', async () => {
    const vaultPath = createVault();
    versioning = new GitVersioning(vaultPath, ENABLED_CONFIG);
    await versioning.init();
    writeVaultFile(vaultPath, 'snapshot.md', '# Snapshot\n');

    await versioning.preCommit('[snapshot] Before risky edit');

    const log = gitLog(vaultPath);
    expect(log).toContain('[snapshot] Before risky edit');
  });

  it('checkpoint() creates a [checkpoint] commit', async () => {
    const vaultPath = createVault();
    versioning = new GitVersioning(vaultPath, ENABLED_CONFIG);
    await versioning.init();
    writeVaultFile(vaultPath, 'checkpoint.md', '# Checkpoint\n');

    await versioning.checkpoint('Manual milestone');

    const log = gitLog(vaultPath);
    expect(log).toContain('[checkpoint] Manual milestone');
  });

  it('shutdownSync() commits pending changes synchronously', async () => {
    const vaultPath = createVault();
    versioning = new GitVersioning(vaultPath, { enabled: true, debounceMs: 10_000 });
    await versioning.init();
    writeVaultFile(vaultPath, '2026010101010100-shutdown.md', '# Shutdown\n');

    versioning.recordOp(pendingOp({ title: 'Shutdown' }));
    versioning.shutdownSync();

    const log = gitLog(vaultPath);
    expect(log).toContain('Store observation: "Shutdown"');
  });

  it('buildCommitMessage() formats a single operation', () => {
    const message = buildCommitMessage(
      [pendingOp({ title: 'Single', project: 'alpha' })],
      ['2026010101010100-single.md'],
      '/tmp/vault',
    );

    expect(message).toBe('Store observation: "Single" [alpha]');
  });

  it('buildCommitMessage() formats batched operations', () => {
    const message = buildCommitMessage(
      [
        pendingOp({ noteId: '2026010101010100', title: 'First' }),
        pendingOp({ op: 'update', noteId: '2026010101010101', title: 'Second', kind: 'decision' }),
      ],
      ['2026010101010100-first.md', '2026010101010101-second.md'],
      '/tmp/vault',
    );

    expect(message).toContain('1 store, 1 update');
    expect(message).toContain('- Store observation: "First"');
    expect(message).toContain('- Update decision: "Second"');
  });

  it('buildCommitMessage() includes external changes', () => {
    const message = buildCommitMessage(
      [pendingOp({ title: 'Known' })],
      ['2026010101010100-known.md', 'manual.md'],
      '/tmp/vault',
    );

    expect(message).toContain('1 store, 1 external');
    expect(message).toContain('- Store observation: "Known"');
    expect(message).toContain('- 1 file changed outside server');
  });

  it('init() recovers a dirty working tree with a [recovery] commit', async () => {
    const vaultPath = createVault();
    initManualRepo(vaultPath);
    writeVaultFile(vaultPath, 'baseline.md', '# Baseline\n');
    manualCommit(vaultPath, 'Baseline');
    appendVaultFile(vaultPath, 'baseline.md', '\nChanged before restart\n');
    writeVaultFile(vaultPath, 'untracked.md', '# Untracked\n');

    versioning = new GitVersioning(vaultPath, ENABLED_CONFIG);
    await versioning.init();

    const log = gitLog(vaultPath);
    expect(log).toContain('[recovery] Uncommitted changes from prior session');
    expect(gitStatus(vaultPath)).toBe('');
  });

  it('batches multiple operations within one debounce window into a single commit', async () => {
    const vaultPath = createVault();
    versioning = new GitVersioning(vaultPath, ENABLED_CONFIG);
    await versioning.init();
    const initialCount = commitCount(vaultPath);
    writeVaultFile(vaultPath, '2026010101010100-first.md', '# First\n');
    writeVaultFile(vaultPath, '2026010101010101-second.md', '# Second\n');

    versioning.recordOp(pendingOp({ noteId: '2026010101010100', title: 'First' }));
    versioning.recordOp(pendingOp({ op: 'update', noteId: '2026010101010101', title: 'Second', kind: 'decision' }));
    await Bun.sleep(DEBOUNCE_MS + 50);

    expect(await waitForCommitCount(vaultPath, initialCount + 1)).toBe(initialCount + 1);
    const log = gitLog(vaultPath);
    expect(log).toContain('1 store, 1 update');
    const fullLog = gitFullLog(vaultPath);
    expect(fullLog).toContain('Store observation: "First"');
    expect(fullLog).toContain('Update decision: "Second"');
  });

  it('.gitignore contains .index/ and .obsidian/', async () => {
    const vaultPath = createVault();
    versioning = new GitVersioning(vaultPath, ENABLED_CONFIG);

    await versioning.init();

    const gitignore = fs.readFileSync(path.join(vaultPath, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.index/');
    expect(gitignore).toContain('.obsidian/');
  });

  it('disabled versioning performs no git operations', async () => {
    const vaultPath = createVault();
    writeVaultFile(vaultPath, '2026010101010100-disabled.md', '# Disabled\n');
    versioning = new GitVersioning(vaultPath, DISABLED_CONFIG);

    await versioning.init();
    versioning.recordOp(pendingOp({ title: 'Disabled' }));
    await versioning.recordImmediate(pendingOp({ title: 'Disabled Immediate' }));
    await versioning.preCommit('[snapshot] Disabled');
    await versioning.checkpoint('Disabled');
    versioning.shutdownSync();

    expect(fs.existsSync(path.join(vaultPath, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(vaultPath, '.gitignore'))).toBe(false);
    expect(versioning.isActive).toBe(false);
  });
});
