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

  beforeAll(async () => {
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

    // Create transport with isolated env (env vars are only passed to subprocess)
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

    // Cleanup temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('responds to tools/list with expected tools', async () => {
    const tools = await client!.listTools();

    const toolNames = tools.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      'knowledge-context', 'knowledge-get', 'knowledge-health', 'knowledge-ingest',
      'knowledge-maintain', 'knowledge-mine', 'knowledge-open', 'knowledge-overview',
      'knowledge-search', 'knowledge-stats', 'knowledge-store', 'knowledge-template',
    ]);

    expect(tools.tools.find(tool => tool.name === 'knowledge-overview')?.description).toContain('Deprecated alias');
    expect(tools.tools.find(tool => tool.name === 'knowledge-stats')?.description).toContain('Deprecated alias');
  });

  it('knowledge-health and its deprecated alias return valid responses', async () => {
    for (const name of ['knowledge-health', 'knowledge-stats']) {
      const result = await client!.callTool({ name, arguments: { project: 'protocol' } });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('text');
      expect(content[0].text).toContain('Knowledge Base Stats');
    }
  });

  it('knowledge-store creates a note', async () => {
    const result = await client!.callTool({
      name: 'knowledge-store',
      arguments: {
        project: 'protocol',
        title: 'E2E Test Note',
        content: 'This is a test note from E2E tests.',
        kind: 'observation',
        summary: 'Test note for MCP protocol verification',
        guidance: 'Ignore this note in production',
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('Stored ');
    expect(content[0].text).toContain('observation:');
  });

  it('knowledge-search finds the stored note', async () => {
    const result = await client!.callTool({
      name: 'knowledge-search',
      arguments: {
        project: 'protocol',
        query: 'E2E test',
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('Found');
    expect(content[0].text).toContain('observation');
    expect(content[0].text).toContain('This is a test note from E2E tests');
  });

  // Client filtering E2E tests — require a server build that includes the client param.
  // When running against a stale dist/, these detect the missing schema field and skip.

  it('knowledge-store accepts client param', async () => {
    // Check if server supports client param via tool schema
    const tools = await client!.listTools();
    const storeTool = tools.tools.find(t => t.name === 'knowledge-store');
    const schema = storeTool?.inputSchema as Record<string, unknown> | undefined;
    const properties = schema?.properties as Record<string, unknown> | undefined;
    if (!properties?.client) return; // stale dist/ — client param not supported yet

    const result = await client!.callTool({
      name: 'knowledge-store',
      arguments: {
        project: 'protocol',
        title: 'Client Param E2E Note',
        content: 'Configure .claude/skills directory for Claude Code.',
        kind: 'procedure',
        client: 'claude-code',
        summary: 'Claude Code skill directory setup',
        guidance: 'Set up .claude/skills for Claude Code',
      },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('Stored ');
  });

  it('knowledge-search with client param filters correctly', async () => {
    // First check if the server supports the client param by looking at tool schema
    const tools = await client!.listTools();
    const searchTool = tools.tools.find(t => t.name === 'knowledge-search');
    const schema = searchTool?.inputSchema as Record<string, unknown> | undefined;
    const properties = schema?.properties as Record<string, unknown> | undefined;
    if (!properties?.client) {
      // Server doesn't support client param yet (stale dist/)
      return;
    }

    // Store a claude-code scoped note
    await client!.callTool({
      name: 'knowledge-store',
      arguments: {
        project: 'protocol',
        title: 'Claude Filtered E2E Note',
        content: 'This is only for Claude Code clients to see.',
        kind: 'reference',
        client: 'claude-code',
        summary: 'Claude-only test note',
        guidance: 'Only visible to claude-code',
      },
    });

    // Search as opencode — should NOT see it
    const openCodeResult = await client!.callTool({
      name: 'knowledge-search',
      arguments: { project: 'protocol', query: 'Claude Filtered E2E', client: 'opencode' },
    });
    const openCodeText = (openCodeResult.content as Array<{ type: string; text: string }>)[0].text;
    expect(openCodeText).not.toContain('This is only for Claude Code');

    // Search as claude-code — SHOULD see it
    const claudeResult = await client!.callTool({
      name: 'knowledge-search',
      arguments: { project: 'protocol', query: 'Claude Filtered E2E', client: 'claude-code' },
    });
    const claudeText = (claudeResult.content as Array<{ type: string; text: string }>)[0].text;
    expect(claudeText).toContain('This is only for Claude Code');

    // Search without client — SHOULD see it (backward compat)
    const allResult = await client!.callTool({
      name: 'knowledge-search',
      arguments: { project: 'protocol', query: 'Claude Filtered E2E' },
    });
    const allText = (allResult.content as Array<{ type: string; text: string }>)[0].text;
    expect(allText).toContain('This is only for Claude Code');
  });

  it('knowledge-context returns a structured matching preference capsule on request', async () => {
    const tools = await client!.listTools();
    const contextTool = tools.tools.find(tool => tool.name === 'knowledge-context');
    const schema = contextTool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(schema?.properties).toHaveProperty('includePreferences');

    await client!.callTool({
      name: 'knowledge-store',
      arguments: {
        project: 'protocol',
        title: 'Pi Protocol Preference',
        content: 'Keep Pi protocol output concise.',
        kind: 'personalization',
        status: 'permanent',
        client: 'pi',
        summary: 'Pi protocol output stays concise',
        guidance: 'Keep Pi protocol output concise.',
      },
    });

    const result = await client!.callTool({
      name: 'knowledge-context',
      arguments: { project: 'protocol', client: 'pi', includePreferences: true },
    });
    const structured = result.structuredContent as {
      preferenceCapsule?: {
        selected?: number;
        omitted?: number;
        text?: string;
      };
    } | undefined;

    expect(structured?.preferenceCapsule?.selected).toBeGreaterThanOrEqual(1);
    expect(structured?.preferenceCapsule?.omitted).toBeGreaterThanOrEqual(0);
    expect(structured?.preferenceCapsule?.text).toContain('[project:protocol, client:pi] Keep Pi protocol output concise.');

    const aliasResult = await client!.callTool({
      name: 'knowledge-overview',
      arguments: { project: 'protocol', client: 'pi', includePreferences: true },
    });
    expect(aliasResult.structuredContent).toEqual(result.structuredContent);
  });

  it('isolates project knowledge while sharing confirmed global derivatives', async () => {
    const store = async (project: string, title: string, content: string) => {
      const result = await client!.callTool({
        name: 'knowledge-store',
        arguments: {
          project,
          title,
          content,
          kind: 'reference',
          summary: `${title} summary`,
          guidance: `Use ${title.toLowerCase()} guidance.`,
        },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const id = /→\s*(\d{12,16})\b/.exec(text)?.[1];
      expect(id).toBeDefined();
      return id as string;
    };

    const alphaId = await store('protocol-alpha', 'Alpha Boundary Note', 'isolationtoken alpha private detail');
    const betaId = await store('protocol-beta', 'Beta Boundary Note', 'isolationtoken beta private detail');
    const candidate = {
      title: 'Shared Boundary Guidance',
      content: 'isolationtoken shared reusable guidance',
      kind: 'reference',
      summary: 'Reusable isolation guidance applies broadly.',
      guidance: 'Apply the reusable isolation guidance.',
    };

    const previewResult = await client!.callTool({
      name: 'knowledge-maintain',
      arguments: { action: 'publish-global', noteId: alphaId, candidate, dryRun: true },
    });
    const previewText = (previewResult.content as Array<{ type: string; text: string }>)[0].text;
    const preview = JSON.parse(previewText) as { valid: boolean; confirmationToken: string };
    expect(preview.valid).toBe(true);

    const applyResult = await client!.callTool({
      name: 'knowledge-maintain',
      arguments: {
        action: 'publish-global', noteId: alphaId, candidate,
        dryRun: false, confirm: true, token: preview.confirmationToken,
      },
    });
    expect((applyResult.content as Array<{ type: string; text: string }>)[0].text).toContain('"created"');

    const search = async (project: string) => {
      const result = await client!.callTool({
        name: 'knowledge-search',
        arguments: { project, query: 'isolationtoken' },
      });
      return (result.content as Array<{ type: string; text: string }>)[0].text;
    };
    const alphaSearch = await search('protocol-alpha');
    expect(alphaSearch).toContain('Alpha Boundary Note');
    expect(alphaSearch).toContain('Reusable isolation guidance applies broadly.');
    expect(alphaSearch).not.toContain('Beta Boundary Note');

    const betaSearch = await search('protocol-beta');
    expect(betaSearch).toContain('Beta Boundary Note');
    expect(betaSearch).toContain('Reusable isolation guidance applies broadly.');
    expect(betaSearch).not.toContain('Alpha Boundary Note');

    const deniedGet = await client!.callTool({
      name: 'knowledge-get',
      arguments: { project: 'protocol-alpha', noteId: betaId },
    });
    expect((deniedGet.content as Array<{ type: string; text: string }>)[0].text).toContain('Note not found');

    const alphaContext = await client!.callTool({
      name: 'knowledge-context',
      arguments: { project: 'protocol-alpha' },
    });
    const alphaContextText = (alphaContext.content as Array<{ type: string; text: string }>)[0].text;
    expect(alphaContextText).toContain('Alpha Boundary Note');
    expect(alphaContextText).toContain('Shared Boundary Guidance');
    expect(alphaContextText).not.toContain('Beta Boundary Note');

    const relatedStore = await client!.callTool({
      name: 'knowledge-store',
      arguments: {
        project: 'protocol-alpha',
        title: 'Shared Boundary Guidance',
        content: 'isolationtoken shared reusable guidance',
        kind: 'reference',
        summary: 'Reusable isolation guidance applies broadly.',
        guidance: 'Keep related-note discovery within the visibility boundary.',
        model: 'claude-opus-4',
      },
    });
    const relatedStoreText = (relatedStore.content as Array<{ type: string; text: string }>)[0].text;
    expect(relatedStoreText).toContain('Shared Boundary Guidance');
    expect(relatedStoreText).not.toContain('Beta Boundary Note');

    const mined = await client!.callTool({
      name: 'knowledge-mine',
      arguments: {
        project: 'protocol-alpha', dry_run: true,
        candidates: [{
          title: 'Beta Private Candidate',
          content: 'beta private detail unique candidate',
          kind: 'reference',
          summary: 'Beta private detail unique candidate.',
          guidance: 'Use beta private detail only when visible.',
        }],
      },
    });
    const minedText = (mined.content as Array<{ type: string; text: string }>)[0].text;
    expect(minedText).toContain('STORE');
    expect(minedText).not.toContain('Beta Boundary Note');
  });

  it('handles unknown tool gracefully', async () => {
    const result = await client!.callTool({
      name: 'nonexistent-tool',
      arguments: {},
    });

    // MCP SDK returns a result with isError flag for unknown tools
    expect(result.isError).toBe(true);
  });

  it('rejects knowledge-store without project', async () => {
    const result = await client!.callTool({
      name: 'knowledge-store',
      arguments: {
        title: 'Missing Project',
        content: 'This should fail.',
        kind: 'observation',
        summary: 'Missing project test',
        guidance: 'Test missing project rejection',
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('project');
  });

  it('knowledge-maintain scope-inventory returns a read-only report', async () => {
    const result = await client!.callTool({
      name: 'knowledge-maintain',
      arguments: { action: 'scope-inventory' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('scope-inventory');
    expect(content[0].text).toContain('mutated');
  });

  it('knowledge-maintain publish-global requires noteId', async () => {
    const result = await client!.callTool({
      name: 'knowledge-maintain',
      arguments: { action: 'publish-global', dryRun: true },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('noteId is required');
  });

  it('knowledge-maintain assign-project requires noteId and project', async () => {
    const missingNoteId = await client!.callTool({
      name: 'knowledge-maintain',
      arguments: { action: 'assign-project', project: 'protocol' },
    });
    const missingNoteIdText = (missingNoteId.content as Array<{ type: string; text: string }>)[0].text;
    expect(missingNoteIdText).toContain('noteId is required');

    const missingProject = await client!.callTool({
      name: 'knowledge-maintain',
      arguments: { action: 'assign-project', noteId: 'nonexistent-note' },
    });
    const missingProjectText = (missingProject.content as Array<{ type: string; text: string }>)[0].text;
    expect(missingProjectText).toContain('a valid project is required');

    const forwardedProject = await client!.callTool({
      name: 'knowledge-maintain',
      arguments: { action: 'assign-project', noteId: 'nonexistent-note', project: 'protocol', dryRun: true },
    });
    const forwardedProjectText = (forwardedProject.content as Array<{ type: string; text: string }>)[0].text;
    expect(forwardedProjectText).toContain('Note not found: nonexistent-note');
    expect(forwardedProjectText).not.toContain('a valid project is required');
  });
});
