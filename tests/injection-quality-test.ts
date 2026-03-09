/**
 * Injection Quality Test
 *
 * Tests whether `knowledge-search` returns the right notes for natural-language
 * queries that an agent would make (guided by AGENTS.md instructions).
 *
 * This answers the question: "Can we eliminate plugin injection if the agent
 * self-searches via AGENTS.md instructions?"
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'path';
import * as fs from 'fs';

function text(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text: string }> };
  return r?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
}

async function run() {
  const tmpDir = fs.mkdtempSync('/tmp/injection-test-');

  const transport = new StdioClientTransport({
    command: 'bun',
    args: [path.resolve('dist/mcp-server.js')],
    env: { ...process.env, XDG_DATA_HOME: tmpDir, XDG_CONFIG_HOME: path.join(tmpDir, 'config') },
  });

  const client = new Client({ name: 'injection-test', version: '1.0' });
  await client.connect(transport);

  // Seed with realistic notes
  const notes = [
    { title: 'Prefers Tailwind CSS', content: 'Use Tailwind utility classes. Avoid Bootstrap.', kind: 'personalization', summary: 'User prefers Tailwind CSS over Bootstrap.', guidance: 'Default to Tailwind for styling.' },
    { title: 'PostgreSQL for all services', content: 'We chose PostgreSQL for ACID transactions and consistency.', kind: 'decision', summary: 'Team uses PostgreSQL for all databases.', guidance: 'Recommend PostgreSQL for new services.' },
    { title: 'Always use TypeScript', content: 'TypeScript for all new projects. No plain JavaScript.', kind: 'personalization', summary: 'User requires TypeScript for all projects.', guidance: 'Write TypeScript, never plain JavaScript.' },
    { title: 'Deploy via GitHub Actions', content: 'All deployments go through GitHub Actions CI/CD pipeline.', kind: 'procedure', summary: 'Deployments use GitHub Actions.', guidance: 'Set up GitHub Actions for new projects.' },
    { title: 'Prefer functional patterns', content: 'Use map/filter/reduce over for loops. Avoid mutation.', kind: 'personalization', summary: 'User prefers functional programming patterns.', guidance: 'Use functional patterns, avoid imperative loops.' },
  ];

  for (const note of notes) {
    await client.callTool({ name: 'knowledge-store', arguments: note });
  }

  // Wait for embeddings to finish (fire-and-forget in MCP server)
  await new Promise(r => setTimeout(r, 3000));

  // Test: queries an agent might make based on AGENTS.md instructions
  const queries = [
    // Direct queries (agent searches for specific topic)
    { query: 'CSS framework recommendation', expectInResult: 'Tailwind', label: 'styling query -> finds Tailwind pref' },
    { query: 'database choice for new service', expectInResult: 'PostgreSQL', label: 'database query -> finds PG decision' },
    { query: 'programming language preference', expectInResult: 'TypeScript', label: 'language query -> finds TS pref' },
    { query: 'how do we deploy', expectInResult: 'GitHub Actions', label: 'deploy query -> finds CI procedure' },
    { query: 'coding style preferences', expectInResult: 'functional', label: 'style query -> finds FP preference' },
    // Harder: implicit queries (agent infers what to search from task context)
    { query: 'starting a new web project', expectInResult: 'TypeScript', label: 'implicit: new project -> finds TS pref' },
    { query: 'setting up a microservice', expectInResult: 'PostgreSQL', label: 'implicit: microservice -> finds PG decision' },
    { query: 'frontend component library', expectInResult: 'Tailwind', label: 'implicit: frontend -> finds Tailwind pref' },
  ];

  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  console.log('\n--- Search Quality: Can natural-language queries find the right notes? ---\n');

  for (const { query, expectInResult, label } of queries) {
    const result = await client.callTool({ name: 'knowledge-search', arguments: { query } });
    const resultText = text(result);
    const found = resultText.includes(expectInResult);
    if (found) {
      console.log(`  PASS: ${label}`);
      pass++;
    } else {
      console.log(`  FAIL: ${label} (searched: "${query}")`);
      console.log(`        Result excerpt: ${resultText.substring(0, 200)}`);
      fail++;
      failures.push(label);
    }
  }

  // Show stats for context
  console.log('\n--- KB Stats ---\n');
  const statsResult = await client.callTool({ name: 'knowledge-maintain', arguments: { action: 'stats' } });
  console.log(text(statsResult));

  await client.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n--- Results: ${pass}/${pass + fail} queries found the right note ---\n`);
  if (fail > 0) {
    console.log('Failed queries:');
    for (const f of failures) console.log(`  - ${f}`);
    console.log('\nThese queries would need plugin injection as backup.\n');
  } else {
    console.log('All queries succeeded — agent self-search via AGENTS.md is sufficient!\n');
  }

  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
