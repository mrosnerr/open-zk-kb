import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id: number;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

describe('MCP Protocol E2E', () => {
  let tempDir: string;
  let serverPath: string;
  let proc: Subprocess<'pipe', 'pipe', 'inherit'> | null = null;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-'));
    serverPath = path.resolve(import.meta.dir, '../dist/mcp-server.js');

    process.env.XDG_DATA_HOME = tempDir;
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterAll(() => {
    if (proc) {
      proc.kill();
      proc = null;
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function sendRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!proc) {
      proc = spawn({
        cmd: ['bun', 'run', serverPath],
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'inherit',
        env: {
          ...process.env,
          XDG_DATA_HOME: tempDir,
          XDG_CONFIG_HOME: tempDir,
        },
      });
    }

    const requestStr = JSON.stringify(request) + '\n';
    proc.stdin.write(requestStr);
    proc.stdin.flush();

    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();

    if (!value) {
      throw new Error('No response from server');
    }

    const responseStr = new TextDecoder().decode(value).trim();
    return JSON.parse(responseStr) as JsonRpcResponse;
  }

  it('responds to tools/list with 3 registered tools', async () => {
    const response = await sendRequest({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 1,
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    expect(response.error).toBeUndefined();

    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(3);

    const toolNames = result.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(['knowledge-maintain', 'knowledge-search', 'knowledge-store']);
  });

  it('knowledge-maintain stats returns valid response', async () => {
    const response = await sendRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'knowledge-maintain',
        arguments: { action: 'stats' },
      },
      id: 2,
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(2);
    expect(response.error).toBeUndefined();

    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Knowledge Base Statistics');
  });

  it('knowledge-store creates a note', async () => {
    const response = await sendRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'knowledge-store',
        arguments: {
          title: 'E2E Test Note',
          content: 'This is a test note from E2E tests.',
          kind: 'observation',
          summary: 'Test note for MCP protocol verification',
          guidance: 'Ignore this note in production',
        },
      },
      id: 3,
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(3);
    expect(response.error).toBeUndefined();

    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toContain('Knowledge stored');
    expect(result.content[0].text).toContain('observation');
    expect(result.content[0].text).toContain('e2e-test-note.md');
  });

  it('knowledge-search finds the stored note', async () => {
    const response = await sendRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'knowledge-search',
        arguments: {
          query: 'E2E test',
        },
      },
      id: 4,
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(4);
    expect(response.error).toBeUndefined();

    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toContain('Found');
    expect(result.content[0].text).toContain('observation');
    expect(result.content[0].text).toContain('This is a test note from E2E tests');
  });

  it('handles unknown tool gracefully', async () => {
    const response = await sendRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'nonexistent-tool',
        arguments: {},
      },
      id: 5,
    });

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(5);
    // MCP SDK may return error or result with isError flag
    const hasError = response.error !== undefined || 
      (response.result as { isError?: boolean })?.isError === true;
    expect(hasError).toBe(true);
  });
});
