#!/usr/bin/env bun
/// <reference types="bun-types" />

import * as p from '@clack/prompts';
import color from 'picocolors';

type CmdResult = { code: number; stdout: string; stderr: string };
type PullRequestSummary = { number: number; url: string; title: string };

function run(cmd: string[], label: string): CmdResult {
  let proc;
  try {
    proc = Bun.spawnSync(cmd, {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
  } catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  return {
    code: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
  };
}

function mustRun(cmd: string[], label: string): string {
  const result = run(cmd, label);
  if (result.code !== 0) {
    throw new Error(`${label} failed${result.stderr ? `: ${result.stderr}` : ''}`);
  }
  return result.stdout;
}

function getNextPatchVersion(current: string): string {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Current version '${current}' is not in X.Y.Z format`);
  }

  const nextPatch = Number(match[3]) + 1;
  return `${match[1]}.${match[2]}.${nextPatch}`;
}

function formatCommitForChangelog(message: string): string {
  const colonMatch = message.match(/^(.+?):\s+(.+)$/);
  if (colonMatch) {
    return `- **${colonMatch[1].trim()}** — ${colonMatch[2].trim()}`;
  }

  const dashMatch = message.match(/^(.+?)\s[-–—]\s(.+)$/);
  if (dashMatch) {
    return `- **${dashMatch[1].trim()}** — ${dashMatch[2].trim()}`;
  }

  return `- ${message.trim()}`;
}

function buildPrBody(version: string, commits: string[]): string {
  const bullets = commits.map((message) => `- ${message}`).join('\n');
  return `## Summary\n\n- Release ${version}\n\n## Changes\n\n${bullets}`;
}

function getExistingReleasePr(base: string, head: string): PullRequestSummary | null {
  const output = mustRun(
    ['gh', 'pr', 'list', '--state', 'open', '--base', base, '--head', head, '--json', 'number,url,title'],
    'gh pr list'
  );
  const prs = JSON.parse(output || '[]') as PullRequestSummary[];
  return prs[0] || null;
}

async function main(): Promise<void> {
  p.intro(color.cyan('open-zk-kb — Release'));

  const ghCheck = run(['gh', '--version'], 'gh --version');
  if (ghCheck.code !== 0) {
    p.log.error('GitHub CLI (gh) is required but not available in PATH');
    process.exit(1);
  }

  const branch = mustRun(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], 'git rev-parse');
  if (branch === 'main') {
    p.log.error('Refusing to release from main. Switch to dev.');
    process.exit(1);
  }
  if (branch !== 'dev') {
    p.log.error(`Release must run on dev branch (current: ${branch})`);
    process.exit(1);
  }

  const status = mustRun(['git', 'status', '--porcelain'], 'git status');
  if (status.length > 0) {
    p.log.error('Working tree is dirty. Commit or stash changes before releasing.');
    process.exit(1);
  }

  const packageFile = Bun.file('package.json');
  const changelogFile = Bun.file('CHANGELOG.md');
  const serverJsonFile = Bun.file('server.json');
  const skillFile = Bun.file('skills/open-zk-kb/SKILL.md');
  const packageJsonText = await packageFile.text();
  const changelogText = await changelogFile.text();
  const serverJsonText = await serverJsonFile.text();
  const skillText = await skillFile.text();
  const pkg = JSON.parse(packageJsonText) as { version?: string };

  if (!pkg.version) {
    p.log.error('package.json is missing version field');
    process.exit(1);
  }

  const requestedVersion = process.argv[2];
  const nextVersion = requestedVersion ?? getNextPatchVersion(pkg.version);
  const existingPr = getExistingReleasePr('main', 'dev');
  if (nextVersion === pkg.version) {
    p.log.error(`Version ${nextVersion} is already current`);
    process.exit(1);
  }

  mustRun(['git', 'fetch', 'origin', 'main'], 'git fetch origin main');
  const rawCommits = mustRun(['git', 'log', '--format=%s', '--no-merges', 'origin/main...HEAD'], 'git log');
  const commitMessages = rawCommits
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^Bump to\b/.test(line));

  if (commitMessages.length === 0) {
    p.log.error('No releasable commits found between origin/main...HEAD');
    process.exit(1);
  }

  const changelogEntry = [`## ${nextVersion}`, '', ...commitMessages.map(formatCommitForChangelog), '', ''].join('\n');
  const updatedChangelog = changelogText.replace(/^# Changelog\n\n/, `# Changelog\n\n${changelogEntry}`);
  if (updatedChangelog === changelogText) {
    p.log.error('Unable to prepend changelog entry (missing expected # Changelog header)');
    process.exit(1);
  }

  const updatedPackageJson = packageJsonText.replace(
    `"version": "${pkg.version}"`,
    `"version": "${nextVersion}"`
  );

  // Sync server.json versions (root version + packages[0].version)
  const updatedServerJson = serverJsonText
    .replace(/"version":\s*"[^"]+"/g, `"version": "${nextVersion}"`);

  // Sync SKILL.md frontmatter version
  const updatedSkillText = skillText.replace(
    /^(---\nname: open-zk-kb\nversion: )[^\n]+/m,
    `$1${nextVersion}`
  );

  p.log.step(`Version: ${pkg.version} ${color.dim('→')} ${nextVersion}`);
  p.log.step(`Commits: ${commitMessages.length}`);
  p.log.message('Preview CHANGELOG entry:');
  for (const line of changelogEntry.trim().split('\n')) {
    p.log.message(`  ${line}`);
  }

  const confirm = await p.confirm({
    message: existingPr
      ? `Apply release changes, commit, push dev, and update PR #${existingPr.number} for ${nextVersion}?`
      : `Apply release changes, commit, push dev, and open PR for ${nextVersion}?`,
    initialValue: true,
  });

  if (p.isCancel(confirm) || !confirm) {
    p.cancel('Release cancelled.');
    process.exit(0);
  }

  await Bun.write('package.json', updatedPackageJson);
  await Bun.write('CHANGELOG.md', updatedChangelog);
  await Bun.write('server.json', updatedServerJson);
  await Bun.write('skills/open-zk-kb/SKILL.md', updatedSkillText);

  mustRun(['git', 'add', 'package.json', 'CHANGELOG.md', 'server.json', 'skills/open-zk-kb/SKILL.md'], 'git add');
  mustRun(['git', 'commit', '-m', `Bump to ${nextVersion}`], 'git commit');
  mustRun(['git', 'push', 'origin', 'dev'], 'git push');

  // Generate descriptive PR title from commits (CI rejects generic "Bump to X.Y.Z")
  const prTitle = commitMessages.length === 1
    ? commitMessages[0]  // Single commit: use its message
    : commitMessages[0]; // Multiple commits: use the first (most recent) as summary
  
  const prBody = buildPrBody(nextVersion, commitMessages);
  if (existingPr) {
    mustRun(['gh', 'pr', 'edit', String(existingPr.number), '--title', prTitle, '--body', prBody], 'gh pr edit');
    p.log.step(`Updated PR #${existingPr.number}: ${existingPr.url}`);
  } else {
    mustRun(
      ['gh', 'pr', 'create', '--base', 'main', '--head', 'dev', '--title', prTitle, '--body', prBody],
      'gh pr create'
    );
  }

  p.outro(color.green(`Release complete: ${nextVersion}`));
}

main().catch((error) => {
  p.log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
