import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { createOpenZkKbPiExtension } from '../src/pi/extension.js';
import { RENDER_RESULTS } from '../src/pi/renderers.js';

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  renderCall?: unknown;
  renderResult?: unknown;
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
        'knowledge-context', 'knowledge-get', 'knowledge-health', 'knowledge-ingest',
        'knowledge-maintain', 'knowledge-mine', 'knowledge-open', 'knowledge-search',
        'knowledge-store', 'knowledge-template',
      ]);
      expect(registered.every((tool) => typeof tool.renderResult === 'function')).toBe(true);
      expect(registered.every((tool) => tool.renderCall === undefined)).toBe(true);
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

  const theme = {
    fg: (_color: string, value: string) => `\u001b[36m${value}\u001b[39m`,
    bold: (value: string) => `\u001b[1m${value}\u001b[22m`,
  };

  const fixtures: Record<string, string> = {
    'knowledge-search': `<note id="2026071801234500" kind="decision" status="permanent" tags="pi, renderer">
  <summary>Use Pi's native tool shell</summary>
  <guidance>Avoid nested borders in result renderers.</guidance>
  <content>Pi already frames tool output.\n\nKeep the result content lightweight.</content>
</note>`,
    'knowledge-store': `Stored observation: "Native renderer behavior" → 2026071801234501

⚠ This note is 350 words. Consider splitting into separate atomic notes.

Related notes:
- [2026071801234500] Existing renderer note`,
    'knowledge-context': `## Project Overview: open-zk-kb

### Inventory
30 observations, 12 decisions, 8 references, 2 resources, 2 personalizations

### Recent Notes
- ⦸ **Use native Pi shell** (decision)

### Resources
- **Pi TUI documentation** [2026071801234502]`,
    'knowledge-health': `# Knowledge Base Stats — open-zk-kb

## Health (62 notes)
- Fleeting: 20
- Permanent: 40
- Archived: 2

## Embeddings
- Embedded: 60/62 notes (2 missing)

## Link Health
- Issues: 3 unlinked, 1 broken (run \`knowledge-maintain link-health\` for details)

## Staleness
- 0–7d: 25

## Growth (last 30d)
- Notes created: 8

## Infrastructure
- Layout: structured

## Version
- Current: 1.4.0`,
    'knowledge-get': `<note id="2026071801234503" kind="procedure" status="permanent" tags="pi, setup">
  <summary>Install Pi package safely</summary>
  <guidance>Keep Bun available on PATH.</guidance>
  <content>Run the installer, restart Pi, and call knowledge-health.</content>
</note>`,
    'knowledge-maintain': 'Checked links',
    'knowledge-mine': 'Found candidates',
    'knowledge-ingest': '# Ingested page',
    'knowledge-template': '# Template',
    'knowledge-open': 'Opened Obsidian vault',
  };

  const storeArgs = {
    title: 'Native renderer behavior',
    kind: 'observation',
    summary: 'Pi result renderers reuse the native tool shell.',
    guidance: 'Keep knowledge-specific output inside Pi’s existing frame.',
    content: '# Observation\n\nPi already frames tool output.\n\nThis second paragraph is not previewed.',
    status: 'permanent',
    lifecycle: 'living',
    project: 'open-zk-kb',
    tags: ['pi', 'renderer'],
  };

  function render(name: string, text: string, expanded: boolean, args: Record<string, unknown> = {}, isError = false, width = 100): string {
    return RENDER_RESULTS[name](
      { content: [{ type: 'text', text }] },
      { expanded },
      theme as never,
      { args, expanded, isPartial: false, isError },
    ).render(width).join('\n');
  }

  it('renders real priority-tool output in collapsed and expanded states', () => {
    const searchCollapsed = render('knowledge-search', fixtures['knowledge-search'], false, { query: 'Pi shell' });
    expect(searchCollapsed).toContain('1 result for "Pi shell"');
    expect(searchCollapsed).toContain("Use Pi's native tool shell");
    expect(searchCollapsed).not.toContain('Pi already frames tool output');
    expect(render('knowledge-search', fixtures['knowledge-search'], true, { query: 'Pi shell' })).toContain('Pi already frames tool output');

    const contextCollapsed = render('knowledge-context', fixtures['knowledge-context'], false);
    expect(contextCollapsed).toContain('open-zk-kb');
    expect(contextCollapsed).toContain('54 notes');
    expect(contextCollapsed).toContain('30 observations');
    const contextExpanded = render('knowledge-context', fixtures['knowledge-context'], true);
    expect(contextExpanded).toContain('Recent Notes');
    expect(contextExpanded).toContain('Resources');

    const healthCollapsed = render('knowledge-health', fixtures['knowledge-health'], false);
    expect(healthCollapsed).toContain('62 notes');
    expect(healthCollapsed).toContain('40 permanent');
    expect(healthCollapsed).toContain('20 fleeting');
    expect(healthCollapsed).toContain('2 archived');
    expect(healthCollapsed).toContain('Issues: 3 unlinked, 1 broken');
    const healthExpanded = render('knowledge-health', fixtures['knowledge-health'], true);
    for (const section of ['Health (62 notes)', 'Embeddings', 'Link Health', 'Staleness', 'Growth (last 30d)', 'Infrastructure', 'Version']) {
      expect(healthExpanded).toContain(section);
    }
  });

  it('renders remaining tools without raw markup in collapsed results', () => {
    const getCollapsed = render('knowledge-get', fixtures['knowledge-get'], false);
    expect(getCollapsed).toContain('Install Pi package safely');
    expect(getCollapsed).toContain('procedure · permanent · 2026071801234503');
    expect(getCollapsed).not.toContain('<note');

    const getExpanded = render('knowledge-get', fixtures['knowledge-get'], true);
    expect(getExpanded).toContain('Keep Bun available on PATH.');
    expect(getExpanded).toContain('Run the installer');

    expect(render('knowledge-ingest', fixtures['knowledge-ingest'], false)).not.toContain('# Ingested page');
    expect(render('knowledge-template', fixtures['knowledge-template'], false)).not.toContain('# Template');
  });

  it('renders a curated store preview without model-facing diagnostics', () => {
    const collapsed = render('knowledge-store', fixtures['knowledge-store'], false, storeArgs);
    expect(collapsed).toContain('Stored "Native renderer behavior"');
    expect(collapsed).toContain('Pi result renderers reuse the native tool shell.');
    expect(collapsed).toContain('observation · 2026071801234501');
    expect(collapsed).not.toContain('Guidance');
    expect(collapsed).not.toContain('350 words');
    expect(collapsed).not.toContain('Related notes');

    const expanded = render('knowledge-store', fixtures['knowledge-store'], true, storeArgs);
    expect(expanded).toContain('Guidance');
    expect(expanded).toContain('Keep knowledge-specific output');
    expect(expanded).toContain('Preview');
    expect(expanded).toContain('Pi already frames tool output.');
    expect(expanded).not.toContain('second paragraph');
    expect(expanded).toContain('permanent · living · project:open-zk-kb · pi · renderer');
    expect(expanded).not.toContain('350 words');
    expect(expanded).not.toContain('Related notes');
  });

  it('preserves complete malformed and error responses', () => {
    const malformed = 'raw response\nsecond line\nfinal diagnostic';
    expect(render('knowledge-search', malformed, false)).toContain(malformed);
    expect(render('knowledge-context', malformed, false)).toContain(malformed);
    expect(render('knowledge-health', malformed, false)).toContain(malformed);
    expect(render('knowledge-store', malformed, false, storeArgs)).toContain(malformed);

    const successLookingError = 'Stored observation: "Looks successful" → 123\nserver rejected the request';
    const failed = render('knowledge-store', successLookingError, false, storeArgs, true);
    expect(failed).toContain('server rejected the request');
    expect(failed).not.toContain('Pi result renderers reuse');

    const longRaw = `raw ${'wrapped content '.repeat(20)}final-token`;
    const wrappedRaw = render('knowledge-search', longRaw, false, {}, false, 24);
    expect(wrappedRaw).toContain('final-token');
    expect(wrappedRaw.split('\n').length).toBeGreaterThan(2);

    const longError = `failure ${'diagnostic detail '.repeat(20)}error-tail`;
    const wrappedError = render('knowledge-health', longError, false, {}, true, 24);
    expect(wrappedError).toContain('error-tail');
    expect(wrappedError.split('\n').length).toBeGreaterThan(2);

    const hostileQuery = '\u001b]2;hostile title\u0007\u001b[2Jquery';
    const sanitized = render('knowledge-search', fixtures['knowledge-search'], false, { query: hostileQuery });
    expect(sanitized).not.toContain('hostile title');
    expect(sanitized).not.toContain('\u001b[2J');
    expect(sanitized).toContain('query');
  });

  it('keeps every renderer within narrow and normal ANSI-aware viewports', () => {
    const args = { ...storeArgs, query: 'a deliberately long semantic search query' };
    for (const width of [12, 24, 80]) {
      for (const expanded of [false, true]) {
        for (const [name, renderer] of Object.entries(RENDER_RESULTS)) {
          const component = renderer(
            { content: [{ type: 'text', text: fixtures[name] }] },
            { expanded },
            theme as never,
            { args, expanded, isPartial: false, isError: false },
          );
          expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
        }
      }
    }
  });
});
