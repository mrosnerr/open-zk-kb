import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'path';
import * as fs from 'fs';

const GENERATION_MODEL = 'onnx-community/Qwen2.5-1.5B-Instruct';
const EMBEDDING_DIMENSIONS = 384;
const TOTAL_EXPECTED = 12;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  \u2705 ${name}`); passed++; }
  else { console.log(`  \u274c ${name}${detail ? `: ${detail}` : ''}`); failed++; }
}

function text(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text: string }> };
  return r?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
}

async function testEmbeddings() {
  console.log('\n\u25b8 Local Embedding Model');

  const { generateEmbedding, cosineSimilarity, DEFAULT_EMBEDDING_CONFIG } = await import('../../src/embeddings.js');

  const t0 = Date.now();
  const result = await generateEmbedding('TypeScript is a typed superset of JavaScript', DEFAULT_EMBEDDING_CONFIG);
  const loadTime = Date.now() - t0;

  check('embedding model loads', result !== null, result === null ? 'returned null' : undefined);
  if (!result) return;

  check(`produces ${EMBEDDING_DIMENSIONS}-dim vector`, result.embedding.length === EMBEDDING_DIMENSIONS, `got ${result.embedding.length}`);

  const norm = Math.sqrt(result.embedding.reduce((s, v) => s + v * v, 0));
  check('vector is normalized (L2 norm ~1.0)', Math.abs(norm - 1.0) < 0.01, `norm = ${norm.toFixed(4)}`);

  console.log(`  \u23f1 Load + embed: ${loadTime}ms`);

  const pairs: Array<{ a: string; b: string; label: string; minSim?: number; maxSim?: number }> = [
    { a: 'I prefer TypeScript for all projects', b: 'Use TypeScript instead of JavaScript', label: 'similar concepts', minSim: 0.5 },
    { a: 'I prefer TypeScript for all projects', b: 'The weather in Tokyo is rainy today', label: 'unrelated topics', maxSim: 0.3 },
    { a: 'We chose PostgreSQL because of ACID transactions', b: 'PostgreSQL was selected for its transactional guarantees', label: 'paraphrased decision', minSim: 0.5 },
    { a: 'Always use ESLint for code quality', b: 'Configure your toaster oven to 350 degrees', label: 'tech vs non-tech', maxSim: 0.2 },
  ];

  for (const { a, b, label, minSim, maxSim } of pairs) {
    const [embA, embB] = await Promise.all([
      generateEmbedding(a, DEFAULT_EMBEDDING_CONFIG),
      generateEmbedding(b, DEFAULT_EMBEDDING_CONFIG),
    ]);

    if (!embA || !embB) {
      check(`similarity: ${label}`, false, 'embedding failed');
      continue;
    }

    const sim = cosineSimilarity(embA.embedding, embB.embedding);
    let ok = true;
    let expected = '';
    if (minSim !== undefined) { ok = sim >= minSim; expected = `>= ${minSim}`; }
    if (maxSim !== undefined) { ok = ok && sim <= maxSim; expected += (expected ? ', ' : '') + `<= ${maxSim}`; }
    check(`similarity: ${label} (${sim.toFixed(3)})`, ok, `expected ${expected}`);
  }
}

async function testTextGeneration() {
  console.log('\n\u25b8 Local Text Generation Model');

  const { pipeline, env } = await import('@huggingface/transformers');
  const cacheDir = process.env.XDG_CACHE_HOME
    ? `${process.env.XDG_CACHE_HOME}/open-zk-kb/models`
    : `${process.env.HOME}/.cache/open-zk-kb/models`;
  env.cacheDir = cacheDir;

  const t0 = Date.now();
  const generator = await pipeline('text-generation', GENERATION_MODEL, { dtype: 'q4' });
  const loadTime = Date.now() - t0;
  check('text generation model loads', true);
  console.log(`  \u23f1 Model load: ${loadTime}ms`);

  const messages = [
    { role: 'system', content: 'You are a helpful assistant. User preference: Default to Elixir when writing backend code. Write concise code without explanation.' },
    { role: 'user', content: 'Write a hello world HTTP server' },
  ];

  const t1 = Date.now();
  const output = await generator(messages, { max_new_tokens: 150, temperature: 0.1 });
  const genTime = Date.now() - t1;
  const result = output as Array<{ generated_text: Array<{ role: string; content: string }> }>;
  const genMessages = result[0]?.generated_text;
  const response = genMessages?.[genMessages.length - 1]?.content || '';

  check('generates non-empty response', response.length > 20, `got ${response.length} chars`);

  const responseLower = response.toLowerCase();
  const mentionsElixir = responseLower.includes('elixir') || responseLower.includes('plug') || responseLower.includes('cowboy') || responseLower.includes('phoenix');
  check('respects KB preference (Elixir)', mentionsElixir, `response: ${response.substring(0, 100)}...`);

  console.log(`  \u23f1 Generation: ${genTime}ms`);
}

async function testKbRoundTripWithEmbeddings() {
  console.log('\n\u25b8 KB Round-Trip with Embeddings');

  const tmpDir = fs.mkdtempSync('/tmp/model-smoke-');

  const transport = new StdioClientTransport({
    command: 'bun',
    args: [path.resolve('dist/mcp-server.js')],
    env: { ...process.env, XDG_DATA_HOME: tmpDir, XDG_CONFIG_HOME: path.join(tmpDir, 'config') },
  });

  const client = new Client({ name: 'model-smoke', version: '1.0' });

  try {
    await client.connect(transport);

    await client.callTool({
      name: 'knowledge-store',
      arguments: {
        title: 'Prefer Tailwind CSS for styling',
        content: 'Use Tailwind CSS utility classes for all frontend styling. Avoid Bootstrap.',
        kind: 'personalization',
        summary: 'User prefers Tailwind CSS over Bootstrap for styling.',
        guidance: 'Default to Tailwind CSS when suggesting styling approaches.',
      },
    });

    await client.callTool({
      name: 'knowledge-store',
      arguments: {
        title: 'PostgreSQL for all databases',
        content: 'We chose PostgreSQL for consistency across services. It handles ACID transactions well.',
        kind: 'decision',
        summary: 'Team standardized on PostgreSQL for all database needs.',
        guidance: 'Recommend PostgreSQL for new services.',
      },
    });

    const searchResult = await client.callTool({
      name: 'knowledge-search',
      arguments: { query: 'What CSS framework should I use for styling?' },
    });
    const searchText = text(searchResult);
    check('semantic search finds relevant note', searchText.includes('Tailwind'), `search: ${searchText.substring(0, 100)}`);

    const statsResult = await client.callTool({
      name: 'knowledge-maintain',
      arguments: { action: 'stats' },
    });
    const statsText = text(statsResult);
    const embeddedMatch = statsText.match(/Embedded: (\d+)\/(\d+)/);
    if (embeddedMatch) {
      const [, withEmb, total] = embeddedMatch;
      check('notes have embeddings', parseInt(withEmb) > 0, `${withEmb}/${total}`);
    } else {
      check('notes have embeddings', false, 'no embedding stats in output');
    }

    await client.close();
  } catch (err) {
    check('KB round-trip', false, String(err));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function run() {
  try {
    await testEmbeddings();
    await testTextGeneration();
    await testKbRoundTripWithEmbeddings();
  } catch (err) {
    console.error(`Fatal: ${err}`);
  }

  console.log(`\nMODEL_SMOKE_RESULT:${passed}:${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
