#!/usr/bin/env bun
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
  const output = await generator(messages, { max_new_tokens: 120, temperature: 0.1 });
  const result = output as Array<{ generated_text: Array<{ role: string; content: string }> }>;
  const genMessages = result[0]?.generated_text;
  return genMessages?.[genMessages.length - 1]?.content || '';
}

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
    console.log(color.dim('\n> I prefer Elixir for backend projects\n'));
    await sleep(500);

    const storeArgs = {
      title: 'Prefer Elixir for backend development',
      content: 'Use Elixir and Phoenix for backend services. Elixir offers fault-tolerant concurrency via the BEAM VM, pattern matching, and excellent tooling with Mix.',
      kind: 'personalization',
      summary: 'Prefer Elixir/Phoenix for backend projects.',
      guidance: 'Default to Elixir when writing backend code unless otherwise specified.',
    };
    tool('knowledge-store', storeArgs);
    await client.callTool({ name: 'knowledge-store', arguments: storeArgs });
    await sleep(800);

    console.log(color.green('✓ Stored as personalization'));
    await sleep(5000);

    // ── Code generation (preference injected via KB search) ──
    clear();
    console.log(color.dim('\n> Write a function to reverse a string\n'));
    await sleep(500);

    const searchArgs = { query: 'language preference', limit: 3 };
    tool('knowledge-search', searchArgs);
    const searchResult = await client.callTool({ name: 'knowledge-search', arguments: searchArgs });
    const context = text(searchResult);
    await sleep(300);

    const guidanceMatch = context.match(/<guidance>([\s\S]*?)<\/guidance>/);
    const summaryMatch = context.match(/<summary>([\s\S]*?)<\/summary>/);
    const preference = guidanceMatch?.[1] || summaryMatch?.[1] || '';
    const systemPrompt = `You are a helpful coding assistant. User preference: ${preference} Write concise code without explanation.`;
    const response = await generateResponse(systemPrompt, 'Write a function to reverse a string');
    const code = extractCode(response);

    console.log(color.green('Here\'s a string reversal function:\n'));
    for (const line of code.split('\n')) {
      console.log(color.dim(`  ${line}`));
    }
    await sleep(5000);

    // ── Stats ──
    clear();
    console.log(color.dim('\n> Tell me about the knowledge base\n'));
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
