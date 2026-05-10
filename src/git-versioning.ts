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

async function gitExec(args: string[], cwd: string): Promise<GitResult> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...GIT_ENV },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function gitExecSync(args: string[], cwd: string): GitResult {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
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
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private committing = false;
  private commitPaused = false;
  private initialized = false;
  private _shuttingDown = false;

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
      this.ensureGitignore();
    }

    this.cleanStaleLock();
    await this.recoverUncommitted();

    this.initialized = true;
    logToFile('INFO', 'Git versioning initialized', {
      vaultPath: this.vaultPath,
      debounceMs: this.config.debounceMs,
    });
  }

  private ensureGitignore(): void {
    const gitignorePath = path.join(this.vaultPath, '.gitignore');

    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, 'utf-8');
      return;
    }

    const existing = fs.readFileSync(gitignorePath, 'utf-8');
    const requiredEntries = GITIGNORE_CONTENT
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'));
    const missing = requiredEntries.filter(entry => !existing.includes(entry));

    if (missing.length > 0) {
      const suffix = '\n# open-zk-kb: derived files\n' + missing.join('\n') + '\n';
      fs.writeFileSync(gitignorePath, existing.trimEnd() + '\n' + suffix, 'utf-8');
    }
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

  private async recoverUncommitted(): Promise<void> {
    const status = await gitExec(['status', '--porcelain'], this.vaultPath);
    if (status.exitCode !== 0 || !status.stdout) return;

    const lines = status.stdout.split('\n').filter(Boolean);
    if (lines.length === 0) return;

    logToFile('INFO', 'Recovering uncommitted changes from prior session', { fileCount: lines.length });

    const addResult = await gitExec(['add', '-A'], this.vaultPath);
    if (addResult.exitCode !== 0) return;

    const modifiedCount = lines.filter(l => l.startsWith(' M') || l.startsWith('M ')).length;
    const newCount = lines.filter(l => l.startsWith('??') || l.startsWith('A ')).length;
    const deletedCount = lines.filter(l => l.startsWith(' D') || l.startsWith('D ')).length;

    const parts: string[] = [];
    if (newCount > 0) parts.push(`${newCount} new`);
    if (modifiedCount > 0) parts.push(`${modifiedCount} modified`);
    if (deletedCount > 0) parts.push(`${deletedCount} deleted`);
    const detail = parts.length > 0 ? `\n\n- ${parts.join('\n- ')}` : '';

    await gitExec(
      ['commit', '-m', `[recovery] Uncommitted changes from prior session${detail}`],
      this.vaultPath,
    );
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
    const addResult = await gitExec(['add', '-A'], this.vaultPath);
    if (addResult.exitCode !== 0) {
      logToFile('WARN', 'git add failed', { stderr: addResult.stderr });
      return;
    }

    const diffResult = await gitExec(['diff', '--cached', '--name-only'], this.vaultPath);
    const stagedFiles = diffResult.stdout ? diffResult.stdout.split('\n').filter(Boolean) : [];

    if (stagedFiles.length === 0) {
      this.opBuffer.length = 0;
      return;
    }

    const message = buildCommitMessage([...this.opBuffer], stagedFiles, this.vaultPath);
    this.opBuffer.length = 0;

    const commitResult = await gitExec(['commit', '-m', message], this.vaultPath);
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

  recordOp(op: PendingOp): void {
    if (!this.config.enabled || !this.initialized) return;
    this.opBuffer.push(op);
    this.scheduleDebounce();
  }

  async recordImmediate(op: PendingOp): Promise<void> {
    if (!this.config.enabled || !this.initialized) return;
    this.opBuffer.push(op);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    await this.commitPending();
  }

  async preCommit(message: string): Promise<void> {
    if (!this.config.enabled || !this.initialized) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.committing = true;
    try {
      for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        if (!this.acquireLock()) {
          await Bun.sleep(jitteredDelay(attempt));
          continue;
        }
        try {
          const addResult = await gitExec(['add', '-A'], this.vaultPath);
          if (addResult.exitCode !== 0) return;

          const diffResult = await gitExec(['diff', '--cached', '--name-only'], this.vaultPath);
          if (!diffResult.stdout) return;

          await gitExec(['commit', '-m', message], this.vaultPath);
        } finally {
          this.releaseLock();
        }
        return;
      }
    } finally {
      this.committing = false;
    }
  }

  async checkpoint(message: string): Promise<void> {
    if (!this.config.enabled || !this.initialized) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.opBuffer.length = 0;

    this.committing = true;
    try {
      for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        if (!this.acquireLock()) {
          await Bun.sleep(jitteredDelay(attempt));
          continue;
        }
        try {
          const addResult = await gitExec(['add', '-A'], this.vaultPath);
          if (addResult.exitCode !== 0) return;

          const diffResult = await gitExec(['diff', '--cached', '--name-only'], this.vaultPath);
          if (!diffResult.stdout) return;

          const fileCount = diffResult.stdout.split('\n').filter(Boolean).length;
          const fullMessage = `[checkpoint] ${message} (${fileCount} files)`;

          await gitExec(['commit', '-m', fullMessage], this.vaultPath);
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

    const status = gitExecSync(['status', '--porcelain'], this.vaultPath);
    if (status.exitCode !== 0 || !status.stdout) return;

    const lines = status.stdout.split('\n').filter(Boolean);
    if (lines.length === 0) return;

    const lockPath = path.join(this.vaultPath, '.git', LOCK_DIR_NAME);
    try {
      fs.mkdirSync(lockPath);
    } catch {
      logToFile('WARN', 'Could not acquire lock during shutdown — startup recovery will handle', {
        pendingOps: this.opBuffer.length,
      });
      return;
    }

    try {
      gitExecSync(['add', '-A'], this.vaultPath);

      const ops = [...this.opBuffer];
      this.opBuffer.length = 0;

      const diffResult = gitExecSync(['diff', '--cached', '--name-only'], this.vaultPath);
      const stagedFiles = diffResult.stdout ? diffResult.stdout.split('\n').filter(Boolean) : [];
      if (stagedFiles.length === 0) return;

      const message = ops.length > 0
        ? buildCommitMessage(ops, stagedFiles, this.vaultPath)
        : `[shutdown] ${stagedFiles.length} uncommitted change${stagedFiles.length !== 1 ? 's' : ''}`;

      gitExecSync(['commit', '-m', message], this.vaultPath);
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
