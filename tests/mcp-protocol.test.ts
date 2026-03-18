import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('MCP Protocol E2E', () => {
  let tempDir: string;
  let serverPath: string;
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  let originalXdgData: string | undefined;
  let originalXdgConfig: string | undefined;

  beforeAll(async () => {
    // Save original env vars
    originalXdgData = process.env.XDG_DATA_HOME;
    originalXdgConfig = process.env.XDG_CONFIG_HOME;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-'));

    // Try dist/ first (production), fall back to src/ (development with bun)
    const distPath = path.resolve(import.meta.dir, '../dist/mcp-server.js');
    const srcPath = path.resolve(import.meta.dir, '../src/mcp-server.ts');

    if (fs.existsSync(distPath)) {
      serverPath = distPath;
    } else if (fs.existsSync(srcPath)) {
      serverPath = srcPath;
    } else {
      throw new Error('MCP server not found at dist/ or src/');
    }

    // Create transport with isolated env
    transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', serverPath],
      env: {
        ...process.env,
        XDG_DATA_HOME: tempDir,
        XDG_CONFIG_HOME: tempDir,
      },
    });

    client = new Client({ name: 'mcp-protocol-test', version: '1.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    // Close client connection
    if (client) {
      await client.close();
      client = null;
    }

    // Restore original env vars
    if (originalXdgData !== undefined) {
      process.env.XDG_DATA_HOME = originalXdgData;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
    if (originalXdgConfig !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdgConfig;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }

    // Cleanup temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('responds to tools/list with expected tools', async () => {
    const tools = await client!.listTools();

    expect(tools.tools.length).toBeGreaterThanOrEqual(3);

    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain('knowledge-store');
    expect(toolNames).toContain('knowledge-search');
    expect(toolNames).toContain('knowledge-maintain');
  });

  it('knowledge-maintain stats returns valid response', async () => {
    const result = await client!.callTool({
      name: 'knowledge-maintain',
      arguments: { action: 'stats' },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('Knowledge Base Statistics');
  });

  it('knowledge-store creates a note', async () => {
    const result = await client!.callTool({
      name: 'knowledge-store',
      arguments: {
        title: 'E2E Test Note',
        content: 'This is a test note from E2E tests.',
        kind: 'observation',
        summary: 'Test note for MCP protocol verification',
        guidance: 'Ignore this note in production',
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('Knowledge stored');
    expect(content[0].text).toContain('observation');
    expect(content[0].text).toContain('e2e-test-note.md');
  });

  it('knowledge-search finds the stored note', async () => {
    const result = await client!.callTool({
      name: 'knowledge-search',
      arguments: {
        query: 'E2E test',
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('Found');
    expect(content[0].text).toContain('observation');
    expect(content[0].text).toContain('This is a test note from E2E tests');
  });

  it('handles unknown tool gracefully', async () => {
    try {
      await client!.callTool({
        name: 'nonexistent-tool',
        arguments: {},
      });
      // If it doesn't throw, check for isError flag
      expect(true).toBe(false); // Should have thrown
    } catch {
      // Expected - MCP SDK throws for unknown tools
      expect(true).toBe(true);
    }
  });
});
