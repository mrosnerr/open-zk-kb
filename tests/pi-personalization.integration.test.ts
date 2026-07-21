import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const piBinary = path.join(root, 'node_modules', '.bin', 'pi');
const extension = path.join(root, 'dist', 'pi', 'extension.js');
const provider = path.join(import.meta.dir, 'support', 'pi-personalization-provider.ts');

function note(id: string, title: string, status: string, tags: string[], body: string): string {
  return `---\nid: "${id}"\ntitle: ${title}\nkind: personalization\nstatus: ${status}\nlifecycle: living\ntags:\n${tags.map(tag => `  - ${tag}`).join('\n')}\nsummary: ${body}\nguidance: ${body}\ncreated: 2026-03-01\nupdated: 2026-03-01\n---\n\n# ${title}\n\n${body}\n`;
}

describe('Pi personalization scope integration', () => {
  it('rebuilds scoped Preferences and runs a read-only preference audit through local Pi', async () => {
    if (!fs.existsSync(piBinary)) {
      throw new Error(`Local Pi binary is unavailable at ${piBinary}; run bun install before this integration test.`);
    }
    if (!fs.existsSync(extension)) {
      throw new Error(`Built Pi package extension is unavailable at ${extension}; run bun run build first.`);
    }

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'open-zk-kb-pi-scope-'));
    const home = path.join(temp, 'home');
    const configHome = path.join(temp, 'xdg-config');
    const dataHome = path.join(temp, 'xdg-data');
    const vault = path.join(dataHome, 'open-zk-kb');
    const preferences = path.join(vault, 'preferences');
    const trace = path.join(temp, 'trace.jsonl');
    fs.mkdirSync(preferences, { recursive: true });
    fs.mkdirSync(path.join(configHome, 'open-zk-kb'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(configHome, 'open-zk-kb', 'config.yaml'), `vault: ${JSON.stringify(vault)}\nembeddings:\n  enabled: false\ntelemetry:\n  enabled: false\n`);
    fs.writeFileSync(path.join(preferences, '2026030100000001-universal.md'), note('2026030100000001', 'Universal concise answers', 'permanent', ['writing'], 'Keep answers concise.'));
    fs.writeFileSync(path.join(preferences, '2026030100000002-pi.md'), note('2026030100000002', 'Pi TypeScript setup', 'fleeting', ['client:pi'], 'For now configure TypeScript output for Pi.'));
    fs.writeFileSync(path.join(preferences, '2026030100000003-project.md'), note('2026030100000003', 'Project Python setup', 'permanent', ['project:atlas'], 'Install Python tooling for Atlas.'));
    const archivedPath = path.join(preferences, '2026030100000004-archived.md');
    fs.writeFileSync(archivedPath, note('2026030100000004', 'Archived Cursor routing', 'archived', [], 'Currently route Cursor to gpt-4.'));
    const sourceBefore = new Map(fs.readdirSync(preferences).filter(name => name.endsWith('.md')).map(name => [name, fs.readFileSync(path.join(preferences, name), 'utf8')]));

    const env = { ...process.env, HOME: home, TMPDIR: path.join(temp, 'tmp'), XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome, XDG_RUNTIME_DIR: path.join(temp, 'runtime'), XDG_STATE_HOME: path.join(temp, 'state'),
      PI_OFFLINE: '1', OPEN_ZK_KB_NO_UPDATE_CHECK: '1', PI_PERSONALIZATION_TRACE: trace };
    for (const directory of [env.TMPDIR, env.XDG_RUNTIME_DIR, env.XDG_STATE_HOME]) fs.mkdirSync(directory, { recursive: true });

    const child = Bun.spawn([piBinary, '--print', '--offline', '--approve', '--no-session', '--no-extensions', '--no-skills',
      '--no-prompt-templates', '--no-context-files', '--no-builtin-tools', '--tools', 'knowledge-maintain',
      '--provider', 'personalization-test', '--model', 'scripted', '--extension', extension, '--extension', provider,
      'Run the personalization integration workflow.'], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exitCode, `Pi failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
      expect(stdout).toContain('integration complete');
      const records = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { tool: string; isError: boolean; text: string; systemPrompt: string });
      expect(records).toHaveLength(2);
      expect(records.every(record => record.tool === 'knowledge-maintain' && !record.isError)).toBe(true);
      expect(records.every(record => record.systemPrompt.includes('Keep answers concise.'))).toBe(true);
      expect(records.every(record => !record.systemPrompt.includes('<'))).toBe(true);
      const audit = records[1].text;
      expect(audit).toContain('Active personalization notes scanned: 3');
      expect(audit).toContain('Mutation: none');
      expect(audit).toContain('temporary-wording: "For now"');
      expect(audit).toContain('configuration-language: "configure"');
      expect(audit).not.toContain('Archived Cursor routing');

      const index = fs.readFileSync(path.join(preferences, 'preferences.md'), 'utf8');
      for (const section of ['## Universal Preferences', '## Harness Preferences', '## Project Preferences']) expect(index).toContain(section);
      const section = (heading: string): string => {
        const start = index.indexOf(heading);
        expect(start).toBeGreaterThanOrEqual(0);
        const next = index.indexOf('\n## ', start + heading.length);
        return index.slice(start, next < 0 ? index.length : next);
      };
      const universal = section('## Universal Preferences');
      const harness = section('## Harness Preferences');
      const project = section('## Project Preferences');
      for (const block of [universal, harness, project]) expect(block).toContain(".where(p => p.status !== 'archived')");
      expect(universal).toContain("p => !tagsFor(p).some(t => t.startsWith('project:') || t.startsWith('#project:') || t.startsWith('client:') || t.startsWith('#client:'))");
      const harnessPredicate = ".where(p => tagsFor(p).some(t => t.startsWith('client:') || t.startsWith('#client:')))";
      const projectPredicate = ".where(p => tagsFor(p).some(t => t.startsWith('project:') || t.startsWith('#project:')))";
      expect(harness).toContain(harnessPredicate);
      expect(harness).not.toContain(projectPredicate);
      expect(project).toContain(projectPredicate);
      expect(project).not.toContain(harnessPredicate);
      for (const [name, before] of sourceBefore) expect(fs.readFileSync(path.join(preferences, name), 'utf8')).toBe(before);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 40_000);
});
