import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NoteRepository } from '../../src/storage/NoteRepository.js';
import { detectProject } from '../../src/opencode-plugin/project-detect.js';
import { fetchKbContext, formatContext } from '../../src/opencode-plugin/context.js';
import { createKbPlugin } from '../../src/opencode-plugin/plugin.js';

async function run() {
  let passed = 0;
  let failed = 0;

  const check = (name: string, ok: boolean, detail?: string) => {
    if (ok) { console.log(`  ✅ ${name}`); passed++; }
    else { console.log(`  ❌ ${name}${detail ? `: ${detail}` : ''}`); failed++; }
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-verify-'));

  try {
    const repo = new NoteRepository(tmpDir);

    repo.store('Domain: test-workspace conventions and scope', {
      title: 'test-workspace domain',
      kind: 'domain' as any,
      status: 'permanent',
      tags: ['project:test-workspace'],
      summary: 'Test workspace for plugin verification',
      guidance: 'Follow test conventions',
    });

    repo.store('Chose FTS5 for plugin search', {
      title: 'FTS5 search decision',
      kind: 'decision',
      status: 'permanent',
      tags: ['project:test-workspace', 'architecture'],
      summary: 'Plugin uses FTS5 only',
      guidance: 'No embeddings in plugin',
    });

    repo.store('User prefers Bun over Node', {
      title: 'Bun runtime preference',
      kind: 'personalization',
      status: 'permanent',
      tags: ['project:test-workspace', 'runtime'],
      summary: 'Bun is required runtime',
      guidance: 'Always use bun commands',
    });

    repo.close();

    // 1. Project detection
    const project = detectProject(`${os.homedir()}/dev/test-workspace`);
    check('detectProject extracts project from ~/dev/ path', project === 'test-workspace');

    const noProject = detectProject('/');
    check('detectProject returns null for root', noProject === null);

    // 2. Readonly NoteRepository
    const readonlyRepo = new NoteRepository(tmpDir, { readonly: true });
    check('readonly repo opens existing DB', readonlyRepo !== null);

    const projectNotes = readonlyRepo.getByTag('project:test-workspace');
    const domain = projectNotes.find(n => (n.kind as string) === 'domain') ?? null;
    check('readonly repo finds domain note', domain !== null && (domain.kind as string) === 'domain');

    const results = readonlyRepo.search('FTS5', { tags: ['project:test-workspace'] });
    check('readonly repo search returns results', results.length > 0);
    readonlyRepo.close();

    // 3. Readonly repo throws on missing DB
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-empty-'));
    let threw = false;
    try { new NoteRepository(emptyDir, { readonly: true }); }
    catch { threw = true; }
    check('readonly repo throws for missing DB', threw);
    fs.rmSync(emptyDir, { recursive: true, force: true });

    // 4. Context fetching
    const readRepo2 = new NoteRepository(tmpDir, { readonly: true });
    const ctx = fetchKbContext(readRepo2, 'test-workspace');
    check('fetchKbContext finds domain note', ctx.domainNote !== null);
    check('fetchKbContext returns project notes', ctx.recentNotes.length > 0);
    check('fetchKbContext excludes domain from recent', !ctx.recentNotes.some(n => n.id === ctx.domainNote?.id));
    readRepo2.close();

    // 5. Context formatting
    const formatted = formatContext(ctx);
    check('formatContext produces non-empty output', formatted.length > 0);
    check('formatContext includes project header', formatted.includes('project: test-workspace'));
    check('formatContext includes domain section', formatted.includes('Domain Note'));
    check('formatContext contains XML note tags', formatted.includes('<note'));

    const emptyFormatted = formatContext({ domainNote: null, recentNotes: [], project: 'empty' });
    check('formatContext returns empty for no notes', emptyFormatted === '');

    // 6. Plugin lifecycle — noop when no project
    const noopFactory = createKbPlugin();
    const noopHooks = await noopFactory({ directory: '/', client: { app: { log: () => {} } } });
    const noopOutput = { system: [] as string[] };
    await noopHooks['experimental.chat.system.transform'](
      { sessionID: 'ses_noop', model: { id: 'test', providerID: 'test' } },
      noopOutput,
    );
    check('noop plugin injects nothing', noopOutput.system.length === 0);

    // 7. Plugin lifecycle — inject on session.created → system.transform
    process.env.__OPEN_ZK_KB_TEST_VAULT = tmpDir;
    const factory = createKbPlugin();
    const hooks = await factory({
      directory: `${os.homedir()}/dev/test-workspace`,
      client: { app: { log: () => {} } },
    });
    delete process.env.__OPEN_ZK_KB_TEST_VAULT;

    await hooks.event({
      event: { type: 'session.created', properties: { info: { id: 'ses_inject' } } },
    });

    const injectOutput = { system: [] as string[] };
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'ses_inject', model: { id: 'test', providerID: 'test' } },
      injectOutput,
    );
    check('plugin injects context after session.created', injectOutput.system.length > 0);
    check('injected context contains KB header', (injectOutput.system[0] || '').includes('Knowledge Base Context'));

    // 8. Inject-once (consumed marker)
    const secondOutput = { system: [] as string[] };
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'ses_inject', model: { id: 'test', providerID: 'test' } },
      secondOutput,
    );
    check('second transform call injects nothing (consumed)', secondOutput.system.length === 0);

    // 9. Compaction re-injects + resets marker
    const compactOutput = { context: [] as string[] };
    await hooks['experimental.session.compacting']({ sessionID: 'ses_inject' }, compactOutput);
    check('compaction pushes context', compactOutput.context.length > 0);

    const postCompactOutput = { system: [] as string[] };
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'ses_inject', model: { id: 'test', providerID: 'test' } },
      postCompactOutput,
    );
    check('post-compaction transform re-injects', postCompactOutput.system.length > 0);

    // 10. Session cleanup
    await hooks.event({
      event: { type: 'session.deleted', properties: { info: { id: 'ses_inject' } } },
    });
    const deletedOutput = { system: [] as string[] };
    await hooks['experimental.chat.system.transform'](
      { sessionID: 'ses_inject', model: { id: 'test', providerID: 'test' } },
      deletedOutput,
    );
    check('deleted session injects nothing', deletedOutput.system.length === 0);

    // 11. Module shape verification
    const pluginModule = await import('../../dist/opencode-plugin/index.js');
    const defaultExport = pluginModule.default;
    check('module has default export', defaultExport !== undefined);
    check('default export has id', defaultExport?.id === 'open-zk-kb');
    check('default export has server function', typeof defaultExport?.server === 'function');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`PLUGIN_RESULT:${passed}:${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(`Fatal: ${err}`);
  console.log('PLUGIN_RESULT:0:99');
  process.exit(1);
});
