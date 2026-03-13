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

function extractCode(response: string): string {
  const fenced = response.match(/```\w*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trimEnd();
  return response.trim();
}

async function generateResponse(systemPrompt: string, userPrompt: string): Promise<string> {
  const { pipeline, env } = await import('@huggingface/transformers');
  const cacheDir = process.env.XDG_CACHE_HOME
    ? `${process.env.XDG_CACHE_HOME}/open-zk-kb/models`
    : `${process.env.HOME}/.cache/open-zk-kb/models`;
  env.cacheDir = cacheDir;

  const generator = await pipeline('text-generation', GENERATION_MODEL, { dtype: 'q4' });
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const output = await generator(messages, { max_new_tokens: 200, temperature: 0.1 });
  const result = output as Array<{ generated_text: Array<{ role: string; content: string }> }>;
  const genMessages = result[0]?.generated_text;
  return genMessages?.[genMessages.length - 1]?.content || '';
}

// Classic Brainfuck "Hello World" — the prompt asks the model to explain it
const BRAINFUCK_SNIPPET = `++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.`;

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
    // ── Store two preferences ──
    console.log(color.cyan('\n─── knowledge-store ───────────────────────────────────\n'));
    console.log(color.dim('Storing user preferences...\n'));
    await sleep(500);

    const pref1 = {
      title: 'Explain code using cooking metaphors',
      content: 'When explaining code, use cooking metaphors. Describe functions as recipes, variables as ingredients, loops as repeated stirring, and conditionals as taste-testing. Make technical concepts feel like a kitchen walkthrough.',
      kind: 'personalization',
      summary: 'Explain code with cooking metaphors.',
      guidance: 'Always explain code using cooking and kitchen metaphors — functions are recipes, variables are ingredients, loops are stirring, conditionals are taste tests.',
    };
    tool('knowledge-store', pref1);
    await client.callTool({ name: 'knowledge-store', arguments: pref1 });
    console.log(color.green('✓ Stored: cooking metaphors preference'));
    await sleep(1000);

    const pref2 = {
      title: 'Show code examples in Python',
      content: 'When showing code examples or translations, always use Python. User is most comfortable reading Python and prefers it for illustrating concepts.',
      kind: 'personalization',
      summary: 'Show code examples in Python.',
      guidance: 'When showing equivalent code or examples, always use Python.',
    };
    tool('knowledge-store', pref2);
    await client.callTool({ name: 'knowledge-store', arguments: pref2 });
    console.log(color.green('✓ Stored: Python examples preference'));
    await sleep(5000);

    // ── Search KB + explain esoteric code ──
    clear();
    console.log(color.cyan('\n─── knowledge-search ──────────────────────────────────\n'));
    console.log(color.dim('Searching KB for preferences before answering...\n'));
    await sleep(500);

    const searchArgs = { query: 'code explanation style and language preference', limit: 5 };
    tool('knowledge-search', searchArgs);
    const searchResult = await client.callTool({ name: 'knowledge-search', arguments: searchArgs });
    const context = text(searchResult);
    await sleep(300);

    // Extract guidance from KB results
    const guidances: string[] = [];
    for (const match of context.matchAll(/<guidance>([\s\S]*?)<\/guidance>/g)) {
      guidances.push(match[1].trim());
    }
    const preferenceBlock = guidances.length > 0
      ? guidances.join(' ')
      : 'Explain code with cooking metaphors and show examples in Python.';

    const systemPrompt = `You are a helpful coding assistant. Follow these user preferences exactly: ${preferenceBlock}`;
    const userPrompt = `Explain what this Brainfuck program does and show the Python equivalent:\n\n${BRAINFUCK_SNIPPET}`;

    console.log(color.dim('\nBrainfuck snippet:\n'));
    console.log(color.yellow(`  ${BRAINFUCK_SNIPPET.slice(0, 60)}...`));
    console.log(color.dim('\nGenerating explanation with KB preferences applied...\n'));

    const response = await generateResponse(systemPrompt, userPrompt);

    for (const line of response.split('\n')) {
      console.log(`  ${line}`);
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
