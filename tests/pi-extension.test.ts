import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createOpenZkKbPiExtension } from '../src/pi/extension.js';

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

function writeMockMcpServer(): { dir: string; serverPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-zk-kb-pi-mcp-'));
  const serverPath = path.join(dir, 'server.mjs');
  fs.writeFileSync(serverPath, `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'notifications/initialized') continue;
    if (message.method === 'initialize') {
      respond(message.id, {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-open-zk-kb', version: '1.0.0' }
      });
      continue;
    }
    if (message.method === 'tools/call') {
      respond(message.id, {
        content: [{ type: 'text', text: 'called ' + message.params.name + ' with ' + JSON.stringify(message.params.arguments) }]
      });
      continue;
    }
    respond(message.id, {});
  }
});
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
`, 'utf-8');
  return { dir, serverPath };
}

describe('Pi extension', () => {
  it('registers knowledge tools and forwards calls through an MCP stdio bridge', async () => {
    const { dir, serverPath } = writeMockMcpServer();
    const registered: RegisteredTool[] = [];
    const shutdownHandlers: Array<() => void | Promise<void>> = [];
    let promptHandler: ((event: { systemPrompt: string }) => { systemPrompt?: string } | Promise<{ systemPrompt?: string }>) | undefined;

    try {
      const extension = createOpenZkKbPiExtension({
        server: {
          command: process.execPath,
          args: [serverPath],
          stderr: 'pipe',
        },
        clientName: 'test-open-zk-kb-pi',
        httpUrl: undefined,
      });

      extension({
        registerTool(tool) {
          registered.push(tool);
        },
        on(event, handler) {
          if (event === 'session_shutdown') {
            shutdownHandlers.push(handler);
          } else if (event === 'before_agent_start') {
            promptHandler = handler;
          }
        },
      });

      expect(registered.map((tool) => tool.name).sort()).toEqual([
        'knowledge-get', 'knowledge-ingest', 'knowledge-maintain', 'knowledge-mine',
        'knowledge-open', 'knowledge-overview', 'knowledge-search', 'knowledge-stats',
        'knowledge-store', 'knowledge-template',
      ]);
      expect(promptHandler).toBeDefined();

      const promptResult = await promptHandler?.({ systemPrompt: 'Base prompt' });
      expect(promptResult?.systemPrompt).toContain('client: "pi"');

      const tool = registered.find((candidate) => candidate.name === 'knowledge-template');
      expect(tool).toBeDefined();
      const result = await tool?.execute('tool-call-1', { kind: 'decision' });

      expect(result?.isError).not.toBe(true);
      expect(result?.content[0]?.text).toContain('called knowledge-template with {"kind":"decision"}');
    } finally {
      for (const handler of shutdownHandlers) {
        await handler();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
