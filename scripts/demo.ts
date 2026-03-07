#!/usr/bin/env bun
// scripts/demo.ts — Visual demo of open-zk-kb for GIF recording
// Usage: bun scripts/demo.ts
// Creates a temporary vault, demonstrates store → search → context injection

import { NoteRepository } from '../src/storage/NoteRepository.js';
import { renderNoteForAgent } from '../src/prompts.js';
import color from 'picocolors';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printSlow(text: string, delay = 30): Promise<void> {
  return new Promise(resolve => {
    let i = 0;
    const interval = setInterval(() => {
      if (i < text.length) {
        process.stdout.write(text[i]);
        i++;
      } else {
        clearInterval(interval);
        process.stdout.write('\n');
        resolve();
      }
    }, delay);
  });
}

function header(text: string): void {
  console.log();
  console.log(color.cyan(color.bold(`  ▸ ${text}`)));
  console.log(color.dim('  ' + '─'.repeat(60)));
}

function dim(text: string): void {
  console.log(color.dim(`  ${text}`));
}

function success(text: string): void {
  console.log(color.green(`  ✓ ${text}`));
}

function note(label: string, value: string): void {
  console.log(`  ${color.dim(label + ':')} ${value}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Set up temporary vault
  const demoVault = path.join(os.tmpdir(), `open-zk-kb-demo-${Date.now()}`);
  fs.mkdirSync(demoVault, { recursive: true });
  fs.mkdirSync(path.join(demoVault, '.index'), { recursive: true });

  const repo = new NoteRepository(demoVault);

  try {
    // ── Banner ──
    console.log();
    console.log(color.cyan(color.bold('  ╭──────────────────────────────────────╮')));
    console.log(color.cyan(color.bold('  │        open-zk-kb  demo             │')));
    console.log(color.cyan(color.bold('  │  persistent knowledge for AI agents │')));
    console.log(color.cyan(color.bold('  ╰──────────────────────────────────────╯')));
    await sleep(1000);

    // ── Step 1: Store knowledge ──
    header('Storing knowledge');
    await sleep(300);

    dim('Agent discovers a decision during conversation...');
    await sleep(500);

    const r1 = repo.store(
      'Use Bun as the runtime instead of Node.js for this project. Bun provides native SQLite bindings (bun:sqlite), faster startup, and built-in TypeScript support without a separate compile step.',
      {
        title: 'Use Bun runtime over Node.js',
        kind: 'decision',
        status: 'permanent',
        tags: ['runtime', 'tooling', 'project:myapp'],
        summary: 'Chose Bun over Node.js for native SQLite, faster startup, and built-in TS.',
        guidance: 'Confirmed decision — follow unless explicitly overridden.',
      },
    );
    success(`Stored: ${color.bold('Use Bun runtime over Node.js')}`);
    note('ID', r1.id);
    note('Kind', 'decision');
    note('Status', 'permanent');
    await sleep(600);

    const r2 = repo.store(
      'User prefers concise responses with bullet points. Avoids paragraphs. Uses emoji for important callouts.',
      {
        title: 'Response style: concise with bullets',
        kind: 'personalization',
        status: 'permanent',
        tags: ['communication', 'style'],
        summary: 'User prefers concise bullet-point responses with emoji callouts.',
        guidance: 'User preference — apply when relevant choices arise.',
      },
    );
    success(`Stored: ${color.bold('Response style: concise with bullets')}`);
    note('ID', r2.id);
    note('Kind', 'personalization');
    await sleep(600);

    const r3 = repo.store(
      'For REST APIs in this project, use Hono framework with Zod validation. Routes go in src/routes/, middleware in src/middleware/. Always return typed responses.',
      {
        title: 'API pattern: Hono + Zod validation',
        kind: 'procedure',
        status: 'permanent',
        tags: ['api', 'patterns', 'project:myapp'],
        summary: 'REST APIs use Hono + Zod. Routes in src/routes/, middleware in src/middleware/.',
        guidance: 'Follow these steps when creating new API endpoints.',
      },
    );
    success(`Stored: ${color.bold('API pattern: Hono + Zod validation')}`);
    note('ID', r3.id);
    note('Kind', 'procedure');
    await sleep(800);

    // ── Step 2: Search ──
    header('Searching knowledge');
    await sleep(300);

    dim('Querying: "what runtime should I use?"');
    await sleep(400);

    const results = repo.search('runtime bun node', { limit: 3 });
    console.log();
    for (const result of results) {
      console.log(color.yellow(`  ┌─ ${result.title}`));
      console.log(color.dim(`  │  Kind: ${result.kind}  Status: ${result.status}`));
      console.log(color.dim(`  │  ${result.summary}`));
      console.log(color.yellow(`  └─`));
    }
    await sleep(1000);

    // ── Step 3: Context injection ──
    header('Context injection (auto-injected into system prompt)');
    await sleep(300);

    dim('On every new session, relevant notes are injected automatically:');
    await sleep(400);
    console.log();

    const allNotes = repo.getAll(10);
    console.log(color.green('  <knowledge-context>'));
    for (const n of allNotes) {
      const xml = renderNoteForAgent(n);
      for (const line of xml.split('\n')) {
        console.log(color.green(`    ${line}`));
      }
    }
    console.log(color.green('  </knowledge-context>'));
    await sleep(1500);

    // ── Stats ──
    header('Knowledge base stats');
    await sleep(300);

    const stats = repo.getStats();
    note('Total notes', String(stats.total));
    note('Permanent', String(stats.permanent));
    note('Fleeting', String(stats.fleeting));
    await sleep(1000);

    console.log();
    console.log(color.cyan(color.bold('  Your agent remembers. Across every session.')));
    console.log();

  } finally {
    // Cleanup
    repo.close();
    fs.rmSync(demoVault, { recursive: true, force: true });
  }
}

main().catch(console.error);
