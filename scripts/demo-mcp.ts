#!/usr/bin/env bun
// demo-mcp.ts — API harness that exercises all three MCP tools in sequence.
// This is a scripted integration example, not a simulation of agent behavior.
// In real usage, AI assistants call these tools automatically via AGENTS.md instructions.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import color from 'picocolors';
import * as fs from 'fs';
import * as path from 'path';

const GENERATION_MODEL = 'onnx-community/Qwen2.5-1.5B-Instruct';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedGenerator: any = null;

async function generateResponse(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!cachedGenerator) {
    const { pipeline, env } = await import('@huggingface/transformers');
    const cacheDir = process.env.XDG_CACHE_HOME
      ? `${process.env.XDG_CACHE_HOME}/open-zk-kb/models`
      : `${process.env.HOME}/.cache/open-zk-kb/models`;
    env.cacheDir = cacheDir;
    cachedGenerator = await pipeline('text-generation', GENERATION_MODEL, { dtype: 'q4' });
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const output = await cachedGenerator(messages, { max_new_tokens: 20, temperature: 0.1 });
  const result = output as Array<{ generated_text: Array<{ role: string; content: string }> }>;
  const genMessages = result[0]?.generated_text;
  return genMessages?.[genMessages.length - 1]?.content || '';
}

const QUESTIONS: Array<{ label: string; prompt: string }> = [
  { label: 'Deadlock', prompt: 'What is a deadlock?' },
  { label: 'Race condition', prompt: 'What is a race condition?' },
  { label: 'Cache', prompt: 'What is a cache?' },
  { label: 'Recursion', prompt: 'What is recursion? Think: a recipe that references itself.' },
  { label: 'Garbage collection', prompt: 'What is garbage collection?' },
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

    // ── Generate answers with preference applied ──
    console.log(color.dim('\nApplying preference to answer questions...\n'));

    const systemPrompt = `You are a helpful assistant. Respond with ONLY a short cooking metaphor, 5-10 words max. No explanation, no preamble, just the metaphor. ${preference}`;

    for (const { label, prompt } of QUESTIONS) {
      const response = await generateResponse(systemPrompt, prompt);
      const raw = response.replace(/^["']|["']$/g, '').split('\n')[0].trim();
      // Strip "X is like" prefix and take up to the first comma, period, or semicolon
      const stripped = raw.replace(/^.*?\bis (like )?/i, '').replace(/[.;,!].*$/, '').trim();
      const metaphor = stripped.charAt(0).toUpperCase() + stripped.slice(1);
      console.log(`  ${color.white(label)} ${color.dim('—')} ${color.dim(`"${metaphor}"`)}`);
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
