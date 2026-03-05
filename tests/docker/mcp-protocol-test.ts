import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function run() {
  let passed = 0;
  let failed = 0;

  const check = (name: string, ok: boolean) => {
    if (ok) { console.log(`  ✅ ${name}`); passed++; }
    else { console.log(`  ❌ ${name}`); failed++; }
  };

  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['dist/mcp-server.js'],
  });

  const client = new Client({ name: 'smoke-test', version: '1.0' });

  try {
    await client.connect(transport);
    check('MCP initialize response', true);
  } catch {
    check('MCP initialize response', false);
    console.log(`MCP_RESULT:${passed}:${4}`);
    process.exit(1);
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
    check('knowledge-store accepted', storeText.includes('stored'));
  } catch {
    check('knowledge-store accepted', false);
  }

  try {
    const searchResult = await client.callTool({
      name: 'knowledge-search',
      arguments: { query: 'Docker smoke test' },
    });
    const searchText = JSON.stringify(searchResult);
    check('knowledge-search found note', searchText.includes('Docker smoke test'));
  } catch {
    check('knowledge-search found note', false);
  }

  try {
    const statsResult = await client.callTool({
      name: 'knowledge-maintain',
      arguments: { action: 'stats' },
    });
    const statsText = JSON.stringify(statsResult);
    check('knowledge-maintain stats', statsText.includes('total'));
  } catch {
    check('knowledge-maintain stats', false);
  }

  await client.close();
  console.log(`MCP_RESULT:${passed}:${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(`Fatal: ${err}`);
  console.log('MCP_RESULT:0:4');
  process.exit(1);
});
