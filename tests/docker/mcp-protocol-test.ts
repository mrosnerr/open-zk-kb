import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function run() {
  let passed = 0;
  let failed = 0;
  const totalExpected = 10;

  const check = (name: string, ok: boolean, detail?: string) => {
    if (ok) { console.log(`  ✅ ${name}`); passed++; }
    else { console.log(`  ❌ ${name}${detail ? `: ${detail}` : ''}`); failed++; }
  };

  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['dist/mcp-server.js'],
  });

  const client = new Client({ name: 'smoke-test', version: '1.0' });

  try {
    await client.connect(transport);
    check('MCP initialize response', true);
  } catch (err) {
    check('MCP initialize response', false, String(err));
    console.log(`MCP_RESULT:${passed}:${totalExpected}`);
    process.exit(1);
  }

  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map(t => t.name);
    check('lists all 3 tools', toolNames.length === 3);
    check('has knowledge-store', toolNames.includes('knowledge-store'));
    check('has knowledge-search', toolNames.includes('knowledge-search'));
    check('has knowledge-maintain', toolNames.includes('knowledge-maintain'));
  } catch (err) {
    check('list tools', false, String(err));
  }

  try {
    const storeResult = await client.callTool({
      name: 'knowledge-store',
      arguments: {
        title: 'Docker smoke test note',
        content: 'This is a test note created during Docker smoke testing.',
        kind: 'observation',
        summary: 'Smoke test verification note',
        guidance: 'Used to verify KB round-trip in Docker.',
      },
    });
    const storeText = JSON.stringify(storeResult);
    check('knowledge-store creates note', storeText.includes('stored'));
  } catch (err) {
    check('knowledge-store creates note', false, String(err));
  }

  try {
    const searchResult = await client.callTool({
      name: 'knowledge-search',
      arguments: { query: 'Docker smoke test' },
    });
    const searchText = JSON.stringify(searchResult);
    check('knowledge-search finds note', searchText.includes('Docker smoke test'));
  } catch (err) {
    check('knowledge-search finds note', false, String(err));
  }

  try {
    const emptySearch = await client.callTool({
      name: 'knowledge-search',
      arguments: { query: 'xyznonexistent999' },
    });
    const emptyText = JSON.stringify(emptySearch);
    const isEmptyResult = emptyText.includes('No matching notes');
    const isVectorFallback = emptyText.includes('Docker smoke test');
    check('knowledge-search nonsense query handled', isEmptyResult || isVectorFallback,
      'expected either empty result or vector fallback');
  } catch (err) {
    check('knowledge-search nonsense query handled', false, String(err));
  }

  try {
    const statsResult = await client.callTool({
      name: 'knowledge-maintain',
      arguments: { action: 'stats' },
    });
    const statsText = JSON.stringify(statsResult);
    check('knowledge-maintain stats returns total', statsText.includes('total'));
  } catch (err) {
    check('knowledge-maintain stats returns total', false, String(err));
  }

  try {
    const reviewResult = await client.callTool({
      name: 'knowledge-maintain',
      arguments: { action: 'review' },
    });
    const reviewText = JSON.stringify(reviewResult);
    check('knowledge-maintain review executes', reviewText.length > 0);
  } catch (err) {
    check('knowledge-maintain review executes', false, String(err));
  }

  await client.close();
  console.log(`MCP_RESULT:${passed}:${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(`Fatal: ${err}`);
  console.log('MCP_RESULT:0:10');
  process.exit(1);
});
