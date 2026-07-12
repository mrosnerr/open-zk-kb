import * as fs from 'fs';
import * as path from 'path';
import { logToFile } from './logger.js';
import type { NoteKind, VersioningConfig } from './types.js';

export type OpType = 'store' | 'update' | 'archive' | 'delete' | 'promote' | 'format';

export interface PendingOp {
  op: OpType;
  noteId: string;
  title: string;
  kind: NoteKind;
  project?: string;
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const LOCK_DIR_NAME = 'kb-commit.lock';
const STALE_LOCK_MS = 30_000;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 100;
const RETRY_MAX_JITTER_MS = 400;

const CLOUD_SYNC_PATTERNS = [
  '/Library/Mobile Documents/',
  '/Library/CloudStorage/',
  '/Dropbox/',
];

const GITIGNORE_CONTENT = `# open-zk-kb: derived files (regenerated from source notes)
.index/
.obsidian/
.templates/
templates/
Home.md
log.md
review.md
`;

function jitteredDelay(attempt: number): number {
  const base = RETRY_BASE_MS * Math.pow(2, attempt);
  const jitter = Math.random() * RETRY_MAX_JITTER_MS;
  return base + jitter;
}

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'open-zk-kb',
  GIT_AUTHOR_EMAIL: 'open-zk-kb@local',
  GIT_COMMITTER_NAME: 'open-zk-kb',
  GIT_COMMITTER_EMAIL: 'open-zk-kb@local',
};

function parsePorcelainPaths(output: string): string[] {
  const records = output.split('\0');
  const paths: string[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4) continue;

    paths.push(record.slice(3));
    if (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C') {
      const sourcePath = records[++index];
      if (sourcePath) paths.push(sourcePath);
    }
  }

  return paths;
}
function parseNulSeparatedPaths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

async function gitExec(args: string[], cwd: string): Promise<GitResult> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...GIT_ENV },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout: args.includes('-z') ? stdout : stdout.trim(), stderr: stderr.trim() };
}

function gitExecSync(args: string[], cwd: string): GitResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });

  return {
    exitCode: result.exitCode,
    stdout: args.includes('-z') ? result.stdout.toString() : result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function buildSummaryLine(ops: PendingOp[], externalCount: number): string {
  if (ops.length === 0 && externalCount > 0) {
    return `${externalCount} external change${externalCount !== 1 ? 's' : ''}`;
  }

  if (ops.length === 1 && externalCount === 0) {
    const op = ops[0];
    const projectSuffix = op.project ? ` [${op.project}]` : '';
    return `${capitalize(op.op)} ${op.kind}: "${op.title}"${projectSuffix}`;
  }

  const counts = new Map<string, number>();
  for (const op of ops) {
    counts.set(op.op, (counts.get(op.op) || 0) + 1);
  }

  const parts: string[] = [];
  for (const [op, count] of counts) {
    parts.push(`${count} ${op}${count !== 1 ? 's' : ''}`);
  }
  if (externalCount > 0) {
    parts.push(`${externalCount} external`);
  }

  return parts.join(', ');
}

function buildCommitBody(ops: PendingOp[], externalCount: number): string {
  if (ops.length <= 1 && externalCount === 0) return '';

  const lines: string[] = [];
  for (const op of ops) {
    const projectSuffix = op.project ? ` [${op.project}]` : '';
    lines.push(`- ${capitalize(op.op)} ${op.kind}: "${op.title}"${projectSuffix}`);
  }
  if (externalCount > 0) {
    lines.push(`- ${externalCount} file${externalCount !== 1 ? 's' : ''} changed outside server`);
  }

  return lines.join('\n');
}

export function buildCommitMessage(ops: PendingOp[], stagedFiles: string[], _vaultPath: string): string {
  const knownPaths = new Set<string>();
  for (const op of ops) {
    for (const file of stagedFiles) {
      if (file.includes(op.noteId)) {
        knownPaths.add(file);
      }
    }
  }

  const activeOps = ops.filter(op =>
    stagedFiles.some(f => f.includes(op.noteId))
  );

  const externalCount = stagedFiles.filter(f => !knownPaths.has(f)).length;

  const summary = buildSummaryLine(activeOps, externalCount);
  const body = buildCommitBody(activeOps, externalCount);

  return body ? `${summary}\n\n${body}` : summary;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export class GitVersioning {
  private readonly vaultPath: string;
  private readonly config: VersioningConfig;
  private readonly opBuffer: PendingOp[] = [];
  private readonly changedPaths = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private committing = false;
  private commitPaused = false;
  private initialized = false;
  private _shuttingDown = false;
  // Existing-repository changes predate this process and are never auto-committed.
  private readonly initialDirtyPaths = new Set<string>();

  constructor(vaultPath: string, config: VersioningConfig) {
    this.vaultPath = vaultPath;
    this.config = config;
  }

  async init(): Promise<void> {
    if (!this.config.enabled || this.initialized) return;

    const gitDir = path.join(this.vaultPath, '.git');

    for (const pattern of CLOUD_SYNC_PATTERNS) {
      if (this.vaultPath.includes(pattern)) {
        logToFile('WARN', 'Vault is in a cloud-synced directory — git versioning may cause conflicts', {
          vaultPath: this.vaultPath,
          pattern,
        });
        break;
      }
    }

    const obsidianGitDir = path.join(this.vaultPath, '.obsidian', 'plugins', 'obsidian-git');
    if (fs.existsSync(obsidianGitDir)) {
      logToFile('WARN', 'Obsidian Git plugin detected — may conflict with server-managed versioning', {
        pluginPath: obsidianGitDir,
      });
    }
    const existingRepository = fs.existsSync(gitDir);
    if (existingRepository) {
      await this.captureInitialDirtyPaths();
    }

    if (!fs.existsSync(gitDir)) {
      const result = await gitExec(['init'], this.vaultPath);
      if (result.exitCode !== 0) {
        logToFile('ERROR', 'Failed to initialize git repository', { stderr: result.stderr });
        return;
      }
      logToFile('INFO', 'Git repository initialized for vault versioning', { vaultPath: this.vaultPath });

      this.ensureGitignore();

      const addResult = await gitExec(['add', '-A'], this.vaultPath);
      if (addResult.exitCode === 0) {
        const statusResult = await gitExec(['diff', '--cached', '--name-only'], this.vaultPath);
        const fileCount = statusResult.stdout ? statusResult.stdout.split('\n').filter(Boolean).length : 0;
        if (fileCount > 0) {
          await gitExec(['commit', '-m', `[init] Knowledge base (${fileCount} files)`], this.vaultPath);
        }
      }
    } else {
      if (this.ensureGitignore()) {
        this.changedPaths.add('.gitignore');
      }
    }

    this.cleanStaleLock();
    this.initialized = true;
    logToFile('INFO', 'Git versioning initialized', {
      vaultPath: this.vaultPath,
      debounceMs: this.config.debounceMs,
    });
  }
  private ensureGitignore(): boolean {
    const gitignorePath = path.join(this.vaultPath, '.gitignore');

    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, 'utf-8');
      return true;
    }

    const existing = fs.readFileSync(gitignorePath, 'utf-8');
    const existingLines = new Set(
      existing.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#')),
    );
    const requiredEntries = GITIGNORE_CONTENT
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'));
    const missing = requiredEntries.filter(entry => !existingLines.has(entry));

    if (missing.length > 0) {
      const suffix = '\n# open-zk-kb: derived files\n' + missing.join('\n') + '\n';
      fs.writeFileSync(gitignorePath, existing.trimEnd() + '\n' + suffix, 'utf-8');
      return true;
    }
    return false;
  }

  private cleanStaleLock(): void {
    const indexLockPath = path.join(this.vaultPath, '.git', 'index.lock');
    if (fs.existsSync(indexLockPath)) {
      try {
        const stat = fs.statSync(indexLockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > STALE_LOCK_MS) {
          fs.unlinkSync(indexLockPath);
          logToFile('WARN', 'Removed stale git index.lock', { age: Math.round(age / 1000) });
        }
      } catch { void 0; }
    }

    const lockPath = path.join(this.vaultPath, '.git', LOCK_DIR_NAME);
    if (!fs.existsSync(lockPath)) return;

    try {
      const stat = fs.statSync(lockPath);
      const age = Date.now() - stat.mtimeMs;
      if (age > STALE_LOCK_MS) {
        fs.rmdirSync(lockPath);
        logToFile('WARN', 'Removed stale commit lock', { age: Math.round(age / 1000), lockPath });
      }
    } catch { void 0; }
  }

  private async captureInitialDirtyPaths(): Promise<void> {
    const status = await gitExec(['status', '--porcelain', '-z'], this.vaultPath);
    if (status.exitCode !== 0) {
      logToFile('WARN', 'Could not inspect existing vault changes before enabling versioning', {
        stderr: status.stderr,
      });
      return;
    }

    for (const filePath of parsePorcelainPaths(status.stdout)) {
      this.initialDirtyPaths.add(filePath);
    }
  }

  private async getStageablePaths(paths: readonly string[]): Promise<string[]> {
    const [tracked, untracked] = await Promise.all([
      gitExec(['ls-files', '-z', '--', ...paths], this.vaultPath),
      gitExec(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths], this.vaultPath),
    ]);

    return [...new Set([
      ...(tracked.exitCode === 0 ? parseNulSeparatedPaths(tracked.stdout) : []),
      ...(untracked.exitCode === 0 ? parseNulSeparatedPaths(untracked.stdout) : []),
    ])];
  }

  private getStageablePathsSync(paths: readonly string[]): string[] {
    const tracked = gitExecSync(['ls-files', '-z', '--', ...paths], this.vaultPath);
    const untracked = gitExecSync(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths], this.vaultPath);

    return [...new Set([
      ...(tracked.exitCode === 0 ? parseNulSeparatedPaths(tracked.stdout) : []),
      ...(untracked.exitCode === 0 ? parseNulSeparatedPaths(untracked.stdout) : []),
    ])];
  }

  private async stageChangedPaths(paths: readonly string[]): Promise<string[]> {
    const eligiblePaths = paths.filter(filePath => !this.initialDirtyPaths.has(filePath));
    if (eligiblePaths.length === 0) return [];
    const stageablePaths = await this.getStageablePaths(eligiblePaths);
    if (stageablePaths.length === 0) return [];

    const addResult = await gitExec(['add', '--', ...stageablePaths], this.vaultPath);
    if (addResult.exitCode !== 0) {
      logToFile('WARN', 'git add failed', { stderr: addResult.stderr });
      return [];
    }

    const diffResult = await gitExec(['diff', '--cached', '--name-only', '-z', '--', ...stageablePaths], this.vaultPath);
    return diffResult.exitCode === 0 ? parseNulSeparatedPaths(diffResult.stdout) : [];
  }

  private stageChangedPathsSync(paths: readonly string[]): string[] {
    const eligiblePaths = paths.filter(filePath => !this.initialDirtyPaths.has(filePath));
    if (eligiblePaths.length === 0) return [];
    const stageablePaths = this.getStageablePathsSync(eligiblePaths);
    if (stageablePaths.length === 0) return [];

    const addResult = gitExecSync(['add', '--', ...stageablePaths], this.vaultPath);
    if (addResult.exitCode !== 0) return [];

    const diffResult = gitExecSync(['diff', '--cached', '--name-only', '-z', '--', ...stageablePaths], this.vaultPath);
    return diffResult.exitCode === 0 ? parseNulSeparatedPaths(diffResult.stdout) : [];
  }

  private acquireLock(): boolean {
    const lockPath = path.join(this.vaultPath, '.git', LOCK_DIR_NAME);
    try {
      fs.mkdirSync(lockPath);
      return true;
    } catch {
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          fs.rmdirSync(lockPath);
          fs.mkdirSync(lockPath);
          return true;
        }
      } catch { void 0; }
      return false;
    }
  }

  private releaseLock(): void {
    const lockPath = path.join(this.vaultPath, '.git', LOCK_DIR_NAME);
    try {
      fs.rmdirSync(lockPath);
    } catch { void 0; }
  }

  private async commitPending(): Promise<void> {
    if (!this.config.enabled || !this.initialized) return;
    if (this.committing || this.commitPaused) return;

    this.committing = true;
    try {
      for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        if (!this.acquireLock()) {
          const delay = jitteredDelay(attempt);
          logToFile('DEBUG', 'Commit lock contention, retrying', { attempt, delay: Math.round(delay) });
          await Bun.sleep(delay);
          continue;
        }

        try {
          await this.doCommit();
        } finally {
          this.releaseLock();
        }
        return;
      }

      logToFile('WARN', 'Failed to acquire commit lock after retries — rescheduling', {
        retries: RETRY_ATTEMPTS,
      });
      this.scheduleDebounce(5000);
    } finally {
      this.committing = false;
    }
  }

  private async doCommit(): Promise<void> {
    const stagedFiles = await this.stageChangedPaths([...this.changedPaths]);

    if (stagedFiles.length === 0) {
      this.opBuffer.length = 0;
      this.changedPaths.clear();
      return;
    }

    const message = buildCommitMessage([...this.opBuffer], stagedFiles, this.vaultPath);
    this.opBuffer.length = 0;
    this.changedPaths.clear();

    const commitResult = await gitExec(['commit', '--only', '-m', message, '--', ...stagedFiles], this.vaultPath);
    if (commitResult.exitCode !== 0) {
      if (commitResult.stdout.includes('nothing to commit') || commitResult.stderr.includes('nothing to commit')) {
        return;
      }
      logToFile('WARN', 'git commit failed', { stderr: commitResult.stderr, exitCode: commitResult.exitCode });
    }
  }

  private scheduleDebounce(overrideMs?: number): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    const delay = overrideMs ?? this.config.debounceMs;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.commitPending().catch(err => {
        logToFile('ERROR', 'Debounced commit failed', { error: String(err) });
      });
    }, delay);
  }

  private recordChangedPaths(paths: readonly string[]): void {
    for (const filePath of paths) {
      const relativePath = path.isAbsolute(filePath) ? path.relative(this.vaultPath, filePath) : path.normalize(filePath);
      if (relativePath === '' || relativePath === '.' || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
        logToFile('WARN', 'Ignoring versioning path outside vault', { filePath });
        continue;
      }
      this.changedPaths.add(relativePath);
    }
  }

  recordOp(op: PendingOp, paths: readonly string[]): void {
    if (!this.config.enabled || !this.initialized) return;
    this.opBuffer.push(op);
    this.recordChangedPaths(paths);
    this.scheduleDebounce();
  }

  async recordImmediate(op: PendingOp, paths: readonly string[]): Promise<void> {
    if (!this.config.enabled || !this.initialized) return;
    this.opBuffer.push(op);
    this.recordChangedPaths(paths);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.commitPending();
  }

  async preCommit(message: string, paths: readonly string[]): Promise<void> {
    if (!this.config.enabled || !this.initialized) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.recordChangedPaths(paths);
    this.committing = true;
    try {
      for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        if (!this.acquireLock()) {
          await Bun.sleep(jitteredDelay(attempt));
          continue;
        }
        try {
          const stagedFiles = await this.stageChangedPaths([...this.changedPaths]);
          if (stagedFiles.length === 0) return;

          const result = await gitExec(['commit', '--only', '-m', message, '--', ...stagedFiles], this.vaultPath);
          if (result.exitCode === 0) {
            this.opBuffer.length = 0;
            this.changedPaths.clear();
          }
        } finally {
          this.releaseLock();
        }
        return;
      }
    } finally {
      this.committing = false;
    }
  }

  async checkpoint(message: string, paths: readonly string[]): Promise<void> {
    if (!this.config.enabled || !this.initialized) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.recordChangedPaths(paths);
    this.opBuffer.length = 0;

    this.committing = true;
    try {
      for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        if (!this.acquireLock()) {
          await Bun.sleep(jitteredDelay(attempt));
          continue;
        }
        try {
          const stagedFiles = await this.stageChangedPaths([...this.changedPaths]);
          if (stagedFiles.length === 0) return;

          const fileCount = stagedFiles.length;
          const fullMessage = `[checkpoint] ${message} (${fileCount} files)`;

          await gitExec(['commit', '--only', '-m', fullMessage, '--', ...stagedFiles], this.vaultPath);
          this.changedPaths.clear();
        } finally {
          this.releaseLock();
        }
        return;
      }
    } finally {
      this.committing = false;
    }
  }

  pauseCommits(): void {
    this.commitPaused = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  resumeCommits(): void {
    this.commitPaused = false;
  }

  shutdownSync(): void {
    if (!this.config.enabled || !this.initialized || this._shuttingDown) return;
    this._shuttingDown = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const lockPath = path.join(this.vaultPath, '.git', LOCK_DIR_NAME);
    try {
      fs.mkdirSync(lockPath);
    } catch {
      logToFile('WARN', 'Could not acquire lock during shutdown', {
        pendingOps: this.opBuffer.length,
      });
      return;
    }

    try {
      const stagedFiles = this.stageChangedPathsSync([...this.changedPaths]);
      const ops = [...this.opBuffer];
      this.changedPaths.clear();
      if (stagedFiles.length === 0) return;

      const message = ops.length > 0
        ? buildCommitMessage(ops, stagedFiles, this.vaultPath)
        : `[shutdown] ${stagedFiles.length} uncommitted change${stagedFiles.length !== 1 ? 's' : ''}`;

      gitExecSync(['commit', '--only', '-m', message, '--', ...stagedFiles], this.vaultPath);
    } finally {
      try { fs.rmdirSync(lockPath); } catch { void 0; }
    }
  }

  get isActive(): boolean {
    return this.config.enabled && this.initialized;
  }

  getStats(): { commitCount: number; lastCommitAge: string | null } | null {
    if (!this.config.enabled || !this.initialized) return null;

    const logResult = gitExecSync(['rev-list', '--count', 'HEAD'], this.vaultPath);
    const commitCount = logResult.exitCode === 0 ? parseInt(logResult.stdout, 10) || 0 : 0;

    let lastCommitAge: string | null = null;
    if (commitCount > 0) {
      const tsResult = gitExecSync(['log', '-1', '--format=%ct'], this.vaultPath);
      if (tsResult.exitCode === 0 && tsResult.stdout) {
        const commitEpoch = parseInt(tsResult.stdout, 10) * 1000;
        const ageSec = Math.floor((Date.now() - commitEpoch) / 1000);
        if (ageSec < 60) lastCommitAge = `${ageSec}s ago`;
        else if (ageSec < 3600) lastCommitAge = `${Math.floor(ageSec / 60)}m ago`;
        else if (ageSec < 86400) lastCommitAge = `${Math.floor(ageSec / 3600)}h ago`;
        else lastCommitAge = `${Math.floor(ageSec / 86400)}d ago`;
      }
    }

    return { commitCount, lastCommitAge };
  }
}

export function createGitVersioning(vaultPath: string, config: VersioningConfig): GitVersioning {
  return new GitVersioning(vaultPath, config);
}
