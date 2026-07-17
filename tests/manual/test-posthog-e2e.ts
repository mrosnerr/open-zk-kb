#!/usr/bin/env bun
/**
 * End-to-end test: verify analytics events reach PostHog.
 *
 * Starts the MCP server in an isolated env with DO_NOT_TRACK unset
 * and share: true, sends tool calls, shuts down gracefully, then starts
 * a second session which should report the first session to PostHog.
 *
 * Usage: bun run tests/manual/test-posthog-e2e.ts
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Read the real analytics ID (or generate one) before isolating env
delete process.env.DO_NOT_TRACK;
const { getOrCreateAnalyticsId } = await import('../../src/analytics.js');
const analyticsId = getOrCreateAnalyticsId();

const SERVER_PATH = path.resolve(import.meta.dir, '../../dist/cli.js');

// Create isolated env that shares the same analytics ID
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-e2e-'));
const configDir = path.join(tmpDir, 'config', 'open-zk-kb');
const dataDir = path.join(tmpDir, 'data');
const stateDir = path.join(tmpDir, 'state');
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

fs.writeFileSync(path.join(configDir, 'config.yaml'), `
telemetry:
  enabled: true
  share: true
  id: "${analyticsId}"
`, 'utf-8');

console.log('📁 Temp dir:', tmpDir);
console.log('🔑 Analytics ID:', analyticsId);
console.log('');

const env: Record<string, string> = {
  ...process.env as Record<string, string>,
  XDG_CONFIG_HOME: path.join(tmpDir, 'config'),
  XDG_DATA_HOME: dataDir,
  XDG_STATE_HOME: stateDir,
  HOME: tmpDir,
};
delete env.DO_NOT_TRACK;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startServer(): ReturnType<typeof spawn> {
  return spawn('bun', ['run', SERVER_PATH, 'server'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

let msgId = 0;
function send(child: ReturnType<typeof spawn>, method: string, params: Record<string, unknown> = {}): void {
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: ++msgId, method, params }) + '\n');
}

async function run() {
  // ── Session 1: Generate data ──
  console.log('▶ Session 1: Starting server...');
  const child1 = startServer();
  let stderr1 = '';
  child1.stderr!.on('data', (data: Buffer) => { stderr1 += data.toString(); });

  send(child1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-test', version: '1.0.0' },
  });
  await sleep(2000);

  console.log('▶ Session 1: Calling knowledge-stats...');
  send(child1, 'tools/call', { name: 'knowledge-stats', arguments: {} });
  await sleep(1000);

  console.log('▶ Session 1: Calling knowledge-search...');
  send(child1, 'tools/call', { name: 'knowledge-search', arguments: { query: 'test' } });
  await sleep(1000);

  console.log('▶ Session 1: Sending SIGTERM (records session end, no network calls)...');
  child1.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    child1.on('exit', (code, signal) => {
      console.log(`   Session 1 exited: code=${code} signal=${signal}`);
      resolve();
    });
    setTimeout(() => { child1.kill('SIGKILL'); resolve(); }, 10000);
  });

  await sleep(1000);

  // ── Session 2: Report previous session ──
  console.log('\n▶ Session 2: Starting server (should report Session 1 to PostHog)...');
  const child2 = startServer();
  let stderr2 = '';
  child2.stderr!.on('data', (data: Buffer) => { stderr2 += data.toString(); });

  send(child2, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-test', version: '1.0.0' },
  });
  await sleep(3000); // Give time for async reporting

  console.log('▶ Session 2: Sending SIGTERM...');
  child2.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    child2.on('exit', (code, signal) => {
      console.log(`   Session 2 exited: code=${code} signal=${signal}`);
      resolve();
    });
    setTimeout(() => { child2.kill('SIGKILL'); resolve(); }, 10000);
  });

  console.log('\n--- Results ---');
  console.log('Analytics ID:', analyticsId);
  if (stderr1) console.log('Session 1 stderr:', stderr1.slice(0, 300));
  if (stderr2) console.log('Session 2 stderr:', stderr2.slice(0, 300));
  console.log('\n🔍 Check PostHog for events from:', analyticsId);
  console.log('   Expected: 1x session event (from Session 1, reported by Session 2)');
  console.log('   Properties: client=e2e-test, tool_search=1, tool_store=0');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('🧹 Cleaned up');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
