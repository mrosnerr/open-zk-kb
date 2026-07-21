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
  rendererDemoRoot,
  vaultPath,
  xdgConfigHome,
  xdgRuntimeDir,
  xdgStateHome,
} from './support.js';

const PROJECT = 'renderer-demo';
const CONCISE_PREFERENCE_ID = '2026071910000000';

type FixtureKind = 'decision' | 'observation' | 'procedure' | 'reference' | 'personalization';

interface Fixture {
  id: string;
  slug: string;
  title: string;
  kind: FixtureKind;
  summary: string;
  guidance: string;
  content: string;
}

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
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
  return stdout;
}

function notePath(fixture: Fixture): string {
  if (fixture.kind === 'personalization') {
    return path.join(vaultPath, 'preferences', `${fixture.id}-${fixture.slug}.md`);
  }
  const folders: Record<Exclude<FixtureKind, 'personalization'>, string> = {
    decision: 'decisions',
    observation: 'observations',
    procedure: 'procedures',
    reference: 'references',
  };
  return path.join(vaultPath, 'projects', PROJECT, folders[fixture.kind], `${fixture.id}-${fixture.slug}.md`);
}

function link(fixture: Pick<Fixture, 'id' | 'slug' | 'title'>): string {
  return `[[${fixture.id}-${fixture.slug}|${fixture.title}]]`;
}

function writeFixture(fixture: Fixture): void {
  const date = new Date().toISOString().slice(0, 10);
  const file = notePath(fixture);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---
id: ${fixture.id}
title: ${fixture.title}
kind: ${fixture.kind}
status: permanent
lifecycle: ${fixture.kind === 'personalization' ? 'living' : 'snapshot'}
type: atomic
tags:
  - pi
  - rendering
  - gallery
  - project:${PROJECT}
  - client:pi
created: ${date}
updated: ${date}
tagline: ${JSON.stringify(fixture.summary)}
---

# ${fixture.title}

${fixture.content}

## Guidance

${fixture.guidance}
`);
}

function linkedFixtures(count: number, includeCookingPreference: boolean): Fixture[] {
  const fixtures: Fixture[] = Array.from({ length: count }, (_, index) => {
    if (index === 0) {
      return {
        id: CONCISE_PREFERENCE_ID,
        slug: 'concise-project-answers',
        title: 'Concise Project Answers',
        kind: 'personalization',
        summary: 'Project explanations stay concise and practical.',
        guidance: 'Keep explanations concise. State the key idea first and omit unnecessary detail.',
        content: '',
      };
    }
    if (index === 1 && includeCookingPreference) {
      return {
        id: '2026071910000001',
        slug: 'explain-code-with-cooking-metaphors',
        title: 'Explain Code With Cooking Metaphors',
        kind: 'personalization',
        summary: 'Technical explanations use cooking metaphors.',
        guidance: 'Explain technical concepts with cooking and kitchen metaphors.',
        content: '',
      };
    }
    const ordinal = String(index).padStart(3, '0');
    return {
      id: `2026071910${String(index).padStart(6, '0')}`,
      slug: `project-knowledge-${ordinal}`,
      title: `Project Knowledge ${ordinal}`,
      kind: index % 4 === 0 ? 'decision' : index % 4 === 1 ? 'observation' : index % 4 === 2 ? 'procedure' : 'reference',
      summary: `Fresh linked project knowledge item ${ordinal}.`,
      guidance: `Use project knowledge item ${ordinal} when it is relevant.`,
      content: '',
    };
  });

  for (const fixture of fixtures) {
    // Self-references resolve during the repository's single-pass rebuild and
    // count as reciprocal links without depending on filesystem scan order.
    fixture.content = `Canonical project entry: ${link(fixture)}.`;
  }
  return fixtures;
}

function resultText(result: { content?: unknown }): string {
  if (!Array.isArray(result.content)) return '';
  return result.content
    .filter((item): item is { type: 'text'; text: string } => Boolean(
      item && typeof item === 'object'
      && (item as { type?: unknown }).type === 'text'
      && typeof (item as { text?: unknown }).text === 'string',
    ))
    .map(item => item.text)
    .join('\n');
}

async function prepareFixtureIndex(canonical: boolean, expectedCount: number): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [path.join(packageRoot, 'dist', 'cli.js'), 'server'],
    cwd: rendererDemoRoot,
    env: demoEnvironment(),
    stderr: 'inherit',
  });
  const client = new Client({ name: 'open-zk-kb-pi-demo-seed', version: '1.0.0' });
  await client.connect(transport);
  try {
    for (const action of canonical ? ['rebuild', 'embed', 'upgrade-vault'] : ['rebuild']) {
      const result = await client.callTool({
        name: 'knowledge-maintain',
        arguments: { action, model: 'scripted-demo' },
      });
      if (result.isError) throw new Error(`Fixture maintenance action ${action} returned an MCP error`);
    }

    if (canonical) {
      const health = await client.callTool({
        name: 'knowledge-health',
        arguments: { project: PROJECT, period: '30d', model: 'scripted-demo' },
      });
      const text = resultText(health);
      for (const expected of [`Health (${expectedCount} notes)`, `Embedded: ${expectedCount}/${expectedCount} notes`, 'All clear', 'Layout: structured', 'Obsidian scaffold: present']) {
        if (!text.includes(expected)) throw new Error(`Canonical fixture is not healthy: missing ${JSON.stringify(expected)}\n${text}`);
      }
    }
  } finally {
    await client.close();
  }
}

function copyOptionalTheme(): string | undefined {
  const source = process.env.OPEN_ZK_KB_PI_DEMO_THEME_JSON;
  if (!source) return undefined;
  const parsed = JSON.parse(fs.readFileSync(path.resolve(source), 'utf8')) as { name?: unknown };
  if (typeof parsed.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(parsed.name)) {
    throw new Error('OPEN_ZK_KB_PI_DEMO_THEME_JSON must contain a safe string name');
  }
  const themeDir = path.join(demoHome, '.pi', 'agent', 'themes');
  fs.mkdirSync(themeDir, { recursive: true });
  fs.copyFileSync(path.resolve(source), path.join(themeDir, `${parsed.name}.json`));
  return parsed.name;
}

async function main(): Promise<void> {
  const healthScreenshot = process.argv.includes('--health-screenshot');
  const canonical = process.argv.includes('--canonical') || healthScreenshot;
  const fixtureCount = healthScreenshot ? 240 : canonical ? 239 : 4;
  fs.rmSync(demoRoot, { recursive: true, force: true });
  for (const dir of [demoHome, demoTmpDir, rendererDemoRoot, xdgConfigHome, xdgRuntimeDir, xdgStateHome, vaultPath]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (process.platform !== 'win32') fs.chmodSync(xdgRuntimeDir, 0o700);
  if (canonical) fs.writeFileSync(path.join(demoRoot, '.canonical'), 'healthy fixture\n');

  const piAgentDir = path.join(demoHome, '.pi', 'agent');
  fs.mkdirSync(piAgentDir, { recursive: true });
  const theme = copyOptionalTheme();
  fs.writeFileSync(path.join(piAgentDir, 'settings.json'), `${JSON.stringify({
    ...(theme ? { theme } : {}),
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
  const archive = (JSON.parse(packOutput) as Array<{ filename: string }>).at(0)?.filename;
  if (!archive) throw new Error('npm pack did not report an archive');
  await run(['tar', '-xzf', path.join(archiveDir, archive), '-C', stageDir]);

  const configDir = path.join(xdgConfigHome, 'open-zk-kb');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), [
    `vault: ${JSON.stringify(vaultPath)}`,
    'embeddings:',
    `  enabled: ${canonical ? 'true' : 'false'}`,
    'telemetry:',
    '  enabled: false',
    '  share: false',
    'obsidian:',
    `  scaffold: ${canonical ? 'true' : 'false'}`,
    '  autoUpgrade: false',
    '',
  ].join('\n'));

  for (const fixture of linkedFixtures(fixtureCount, healthScreenshot)) writeFixture(fixture);
  await prepareFixtureIndex(canonical, fixtureCount);
  assertDemoIsolation();
  console.log(`Pi demo staged at ${packageRoot}`);
  console.log(`Isolated vault: ${vaultPath}`);
}

await main();
