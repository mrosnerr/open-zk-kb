#!/usr/bin/env bun
// demo-mcp.ts — Exercises all three MCP tools in sequence with curated output.
// The store, search, and stats calls are real MCP calls against a live server.
// The "generation" step uses pre-written answers to ensure consistent demo quality.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import color from 'picocolors';
import * as fs from 'fs';
import * as path from 'path';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const clear = () => process.stdout.write('\x1B[2J\x1B[H');

function text(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text: string }> };
  if (!r?.content) return '';
  return r.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

function tool(name: string, args: Record<string, unknown>): void {
  const brief = Object.entries(args)
    .filter(([k]) => k === 'title' || k === 'query' || k === 'action')
    .map(([, v]) => v)
    .join(' ');
  console.log(color.dim(`⚙ ${name}`) + color.dim(brief ? ` ${brief}` : ''));
}

// Curated answers — what a capable model would produce with the cooking preference
const ANSWERS: Array<{ prompt: string; label: string; metaphor: string }> = [
  { prompt: 'What is a deadlock?', label: 'Deadlock', metaphor: 'Two chefs blocking the kitchen door, each waiting for the other to move' },
  { prompt: 'What is a race condition?', label: 'Race condition', metaphor: 'Two cooks grabbing the last egg at the same time' },
  { prompt: 'What is a cache?', label: 'Cache', metaphor: 'Keeping your most-used spices on the counter instead of the pantry' },
  { prompt: 'What is recursion?', label: 'Recursion', metaphor: 'A recipe that says "follow this recipe again" as step one' },
  { prompt: 'What is garbage collection?', label: 'Garbage collection', metaphor: 'Clearing plates while the dinner party is still going' },
];

async function main() {
  const tmpDir = '/tmp/kb-demo';
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const transport = new StdioClientTransport({
    command: 'bun',
    args: [path.resolve('dist/mcp-server.js')],
    env: {
      ...process.env,
      XDG_DATA_HOME: tmpDir,
      XDG_CONFIG_HOME: path.join(tmpDir, 'config'),
    },
  });

  const client = new Client({ name: 'demo', version: '1.0' });
  await client.connect(transport);

  try {
    // ── Store ──
    console.log(color.cyan('\n─── knowledge-store ───────────────────────────────────\n'));
    console.log(color.dim('Storing a user preference...\n'));
    await sleep(500);

    const pref = {
      title: 'Explain technical concepts using cooking metaphors',
      content: 'When explaining technical concepts, always use cooking and kitchen metaphors. Functions are recipes, variables are ingredients, loops are repeated stirring, conditionals are taste-testing, caches are spice racks, and errors are burnt dishes.',
      kind: 'personalization',
      summary: 'Explain technical concepts with cooking metaphors.',
      guidance: 'Always explain technical concepts using cooking and kitchen metaphors.',
    };
    tool('knowledge-store', pref);
    await client.callTool({ name: 'knowledge-store', arguments: pref });
    console.log(color.green('✓ Stored as personalization'));
    await sleep(5000);

    // ── Search KB ──
    clear();
    console.log(color.cyan('\n─── knowledge-search ──────────────────────────────────\n'));
    console.log(color.dim('Searching KB for preferences before answering...\n'));
    await sleep(500);

    const searchArgs = { query: 'explanation preferences', limit: 3 };
    tool('knowledge-search', searchArgs);
    const searchResult = await client.callTool({ name: 'knowledge-search', arguments: searchArgs });
    const context = text(searchResult);
    await sleep(300);

    const guidanceMatch = context.match(/<guidance>([\s\S]*?)<\/guidance>/);
    const preference = guidanceMatch?.[1]?.trim() || '';
    if (preference) {
      console.log(color.green(`  ✓ ${preference}`));
    }

    await sleep(2000);

    // ── Show curated answers with preference applied ──
    console.log(color.dim('\nApplying preference to answer questions...\n'));

    for (const { prompt, label, metaphor } of ANSWERS) {
      console.log(color.dim(`  > ${prompt}`));
      await sleep(400);
      console.log(`  ${color.white(label)} ${color.dim('—')} ${color.dim(`"${metaphor}"`)}`);
      console.log('');
      await sleep(800);
    }
    await sleep(5000);

    // ── Stats ──
    clear();
    console.log(color.cyan('\n─── knowledge-maintain stats ──────────────────────────\n'));
    await sleep(500);

    const statsArgs = { action: 'stats' };
    tool('knowledge-maintain', statsArgs);
    const stats = await client.callTool({ name: 'knowledge-maintain', arguments: statsArgs });
    console.log(text(stats));
    await sleep(4000);

  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(console.error);
