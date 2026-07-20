#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  assertDemoIsolation,
  demoEnvironment,
  demoHome,
  demoRoot,
  demoTmpDir,
  packageRoot,
  projectRoot,
  vaultPath,
  xdgConfigHome,
  xdgRuntimeDir,
  xdgStateHome,
} from './support.js';

async function run(command: string[], capture = false): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: projectRoot,
    env: demoEnvironment(),
    stdin: 'ignore',
    stdout: capture ? 'pipe' : 'inherit',
    stderr: 'inherit',
  });
  const stdout = capture ? await new Response(child.stdout).text() : '';
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited with ${exitCode}`);
  }
  return stdout;
}

function fixtureNote(
  id: string,
  slug: string,
  title: string,
  kind: 'decision' | 'observation' | 'procedure',
  summary: string,
  guidance: string,
  content: string,
): void {
  const note = `---
id: ${id}
title: ${title}
kind: ${kind}
status: permanent
lifecycle: snapshot
type: atomic
tags:
  - pi
  - rendering
  - gallery
  - project:renderer-demo
  - client:pi
created: 2026-07-19
updated: 2026-07-19
tagline: "${summary}"
---

# ${title}

${content}

## Guidance

${guidance}
`;
  fs.writeFileSync(path.join(vaultPath, `${id}-${slug}.md`), note);
}

async function rebuildFixtureIndex(): Promise<void> {
  const env = demoEnvironment();
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [path.join(packageRoot, 'dist', 'cli.js'), 'server'],
    cwd: projectRoot,
    env,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'open-zk-kb-pi-demo-seed', version: '1.0.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: 'knowledge-maintain',
      arguments: { action: 'rebuild', model: 'scripted-demo' },
    });
    if (result.isError) {
      throw new Error('Fixture index rebuild returned an MCP error');
    }
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  fs.rmSync(demoRoot, { recursive: true, force: true });
  for (const dir of [demoHome, demoTmpDir, xdgConfigHome, xdgRuntimeDir, xdgStateHome, vaultPath]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (process.platform !== 'win32') fs.chmodSync(xdgRuntimeDir, 0o700);

  const piAgentDir = path.join(demoHome, '.pi', 'agent');
  fs.mkdirSync(piAgentDir, { recursive: true });
  fs.writeFileSync(path.join(piAgentDir, 'settings.json'), `${JSON.stringify({
    quietStartup: true,
    hideThinkingBlock: true,
    enableInstallTelemetry: false,
    defaultProjectTrust: 'always',
  }, null, 2)}\n`);

  await run(['bun', 'run', 'build']);

  const archiveDir = path.join(demoRoot, 'archive');
  const stageDir = path.dirname(packageRoot);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const packOutput = await run(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', archiveDir], true);
  const packs = JSON.parse(packOutput) as Array<{ filename: string }>;
  const archive = packs.at(0)?.filename;
  if (!archive) throw new Error('npm pack did not report an archive');
  await run(['tar', '-xzf', path.join(archiveDir, archive), '-C', stageDir]);

  const configDir = path.join(xdgConfigHome, 'open-zk-kb');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), [
    `vault: ${JSON.stringify(vaultPath)}`,
    'embeddings:',
    '  enabled: false',
    'telemetry:',
    '  enabled: false',
    '  share: false',
    'obsidian:',
    '  scaffold: false',
    '  autoUpgrade: false',
    '',
  ].join('\n'));

  fixtureNote(
    '2026071909000000',
    'native-pi-renderer-decisions',
    'Native Pi Renderer Decisions',
    'decision',
    'Knowledge results use Pi’s native shell and compact themed renderers.',
    'Keep knowledge-specific content inside Pi’s native tool presentation.',
    '## Decision\nOpen-zk-kb uses Pi’s native tool header and shell. Collapsed results emphasize titles, kinds, counts, and summaries; expanded results reveal complete useful context.',
  );
  fixtureNote(
    '2026071909010000',
    'deterministic-gallery-capture',
    'Deterministic Gallery Capture',
    'observation',
    'Gallery media comes from the packed package running in an isolated Pi session.',
    'Regenerate Pi gallery media through the scripted provider and isolated vault.',
    '## What I Saw\nA real Pi capture catches native framing, viewport wrapping, expansion behavior, and package-only runtime failures that handcrafted terminal output misses.',
  );
  fixtureNote(
    '2026071909020000',
    'pi-demo-release-checklist',
    'Pi Demo Release Checklist',
    'procedure',
    'Preview collapsed and expanded knowledge results before publishing media.',
    'Run the local Pi preview and approve search, store, context, and health rendering.',
    '## Steps\nSearch the seeded rendering decisions, expand the result, store the gallery observation, inspect context and health, then verify a narrow viewport.',
  );

  await rebuildFixtureIndex();
  assertDemoIsolation();
  console.log(`Pi demo staged at ${packageRoot}`);
  console.log(`Isolated vault: ${vaultPath}`);
}

await main();
