import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { injectAgentDocs } from '../src/agent-docs.js';
import { getClientInstructionConfigs, getInstalledInstructionVersions } from '../src/instruction-versions.js';
import { TOOL_DEFINITIONS } from '../src/tool-meta.js';

const root = path.resolve(import.meta.dir, '..');
const tempDirs: string[] = [];

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function managedBody(content: string): string {
  return content
    .replace(/<!-- OPEN-ZK-KB:START[^>]*-->\n/, '')
    .replace(/\n<!-- OPEN-ZK-KB:END -->\n?$/, '');
}

/** Deterministic canonical-body word count: the client pointer line is excluded. */
function bodyWordCount(body: string): number {
  return body
    .split('\n')
    .filter(line => !line.startsWith('**Client pointer:**'))
    .join(' ')
    .split(/\s+/)
    .filter(word => /[A-Za-z0-9]/.test(word)).length;
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-zk-guidance-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('precision-first instruction contract', () => {
  it('uses one canonical policy for compatibility sizes and only changes the OMP pointer', () => {
    const dir = tempDir();
    const outputs = new Map<string, string>();
    for (const size of ['compact', 'rules', 'full', 'preflight'] as const) {
      const file = path.join(dir, `${size}.md`);
      injectAgentDocs(file, size, false, undefined, '1.4.2');
      outputs.set(size, managedBody(fs.readFileSync(file, 'utf8')));
    }

    expect(outputs.get('compact')).toBe(outputs.get('full'));
    expect(outputs.get('rules')).toBe(outputs.get('full'));
    expect(outputs.get('preflight')?.replace('`skill://open-zk-kb`.', '`knowledge-template --kind {kind}` and the `open-zk-kb` skill where supported.')).toBe(outputs.get('full'));
    expect(fs.existsSync(path.join(root, 'templates/install/agent-instructions-compact.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'templates/install/agent-instructions-rules.md'))).toBe(false);
  });

  it('ships the four gates, exclusions, zero-capture success, and conditional reuse/update behavior', () => {
    const surfaces = [
      read('templates/install/agent-instructions-full.md'),
      read('templates/install/agent-instructions-preflight.md'),
      read('skill-templates/open-zk-kb/SKILL.md'),
    ];
    for (const content of surfaces) {
      expect(content).toContain('Novel');
      expect(content).toContain('Durable');
      expect(content).toContain('Behavior-changing');
      expect(content).toContain('Canonical here');
      expect(content).toContain('Zero captures is a successful result');
      expect(content).toContain('progress');
      expect(content).toContain('transient research');
      expect(content).toContain('adequate existing note');
      expect(content).toContain('supported reviewed update');
      expect(content).toContain('no safe update path exists');
      expect(content).not.toContain('store immediately, never defer');
      expect(content).not.toContain('Store first, then work');
    }
  });

  it('states exact canonical ownership and injection boundaries on every generated instruction surface', () => {
    const dir = tempDir();
    const bodies: string[] = [];
    for (const size of ['compact', 'rules', 'full', 'preflight'] as const) {
      const file = path.join(dir, `${size}.md`);
      injectAgentDocs(file, size, false, undefined, '1.4.2');
      bodies.push(managedBody(fs.readFileSync(file, 'utf8')));
    }
    bodies.push(read('templates/install/agent-instructions-full.md'), read('templates/install/agent-instructions-preflight.md'));

    for (const body of bodies) {
      expect(body).toContain('**OpenSpec:** active scope, requirements, design, tasks.');
      expect(body).toContain('**Code/tests:** implemented behavior.');
      expect(body).toContain('**Maintained docs:** supported usage, architecture.');
      expect(body).toContain('**Git:** integrated history. **Issues:** unresolved coordination.');
      expect(body).toContain('**Knowledge base:** durable agent memory lacking a better home.');
      expect(body).toContain('Injection is independent of persistence');
      expect(body).toContain(
        'automatic note context carries only applicable permanent preferences (max 12; 800-token estimate)\u2014never bodies, inventory, resources, activity, requirements, design, progress.'
      );
      expect(body).toContain('Handle explicit enduring-memory requests under these gates.');
      expect(body).toContain('`knowledge-search` in compact mode');
      expect(body).toContain('escalate once to exact-ID `knowledge-get`');
      expect(body).toContain('Preserve existing notes; rehome only after destination verification; archive and delete separately.');
      expect(body).toContain('Pass the current project on routine calls; never create global knowledge routinely.');
      expect(body).toContain('`index` and `log` are server-generated');
      expect(bodyWordCount(body)).toBeLessThanOrEqual(200);
    }
  });

  it('snapshots conservative mixed-note rehoming and retirement guidance', () => {
    const content = read('skill-templates/open-zk-kb/SKILL.md');
    expect(content).toContain('**Keep** it when its concept and destination are correct.');
    expect(content).toContain('**Distill** it when it contains durable guidance mixed with noise.');
    expect(content).toContain('preserve the source, copy or distill into the destination-specific code, test, Git, issue, OpenSpec, or docs record');
    expect(content).toContain('**Archive after verification** only when the destination is confirmed; otherwise defer.');
    expect(content).toContain('Use normal destination tools');
    expect(content).toContain('For mixed notes, extract only the qualifying concept; do not silently move unrelated material.');
    expect(content).toContain('Preserve → copy/distill → verify → archive.');
    expect(content).toContain('Deletion is separate and explicit');
  });

  it('reviews precision before omissions and accepts no capture', () => {
    const content = read('skills/session-review/SKILL.md');
    expect(content).toContain('Capture precision');
    expect(content).toContain('First inspect session-created notes for overcapture');
    expect(content).toContain('Do not store plausible candidates automatically');
    expect(content).toContain('Zero qualifying candidates is a successful review');
    expect(content).not.toContain('Capture completeness');
    expect(content).not.toContain('Store it now if so');
  });

  it('encodes all three TTSR truthfulness branches', () => {
    const content = read('templates/install/omp-ttsr-enforce.md');
    expect(content).toContain('persistence is safe and available, call `knowledge-store` in this turn');
    expect(content).toContain('If persistence is unavailable or unsafe, correct the promise without claiming storage');
    expect(content).toContain('If the content fails the gate or is unqualified, say it was not stored; do not command unrelated storage');
    expect(content).not.toContain('Call `knowledge-store` NOW');
  });

  it('reports managed instruction paths for Pi and OMP from shared targets', () => {
    const configs = getClientInstructionConfigs();
    expect(configs.map(config => config.client)).toEqual(['claude-code', 'opencode', 'windsurf', 'pi', 'omp']);
    expect(configs.find(config => config.client === 'pi')?.agentDocsPath?.endsWith('/.pi/agent/AGENTS.md')).toBe(true);
    expect(configs.find(config => config.client === 'omp')?.agentDocsPath?.endsWith('/.omp/agent/rules/open-zk-kb.md')).toBe(true);
  });

  it('detects installed versions for Claude Code, OpenCode, Windsurf, Pi, and OMP', () => {
    const home = tempDir();
    const skillDir = path.join(home, 'claude-code-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nversion: 1.4.2\n---\n');
    const configs = [
      { client: 'claude-code', name: 'Claude Code', skillPath: skillDir },
      ...['opencode', 'windsurf', 'pi', 'omp'].map(client => ({
        client,
        name: client,
        agentDocsPath: path.join(home, `${client}.md`),
      })),
    ];
    for (const config of configs) {
      if (config.agentDocsPath) {
        injectAgentDocs(config.agentDocsPath, config.client === 'omp' ? 'preflight' : 'full', false, undefined, '1.4.2');
      }
    }
    const installed = getInstalledInstructionVersions(configs);
    expect(installed.map(item => item.client)).toEqual(['claude-code', 'opencode', 'windsurf', 'pi', 'omp']);
    expect(installed.every(item => item.instructionVersion === '1.4.2')).toBe(true);
  });

  it('extends the public knowledge-store schema with optional reviewed operation fields', () => {
    const store = TOOL_DEFINITIONS.find(tool => tool.name === 'knowledge-store');
    expect(store).toBeDefined();
    expect(Object.keys(store?.params ?? {})).toEqual([
      'title', 'content', 'kind', 'summary', 'guidance', 'status', 'lifecycle', 'tags', 'project', 'client', 'related', 'model',
      'dryRun', 'disposition', 'noteId', 'expectedUpdatedAt', 'confirm', 'token',
    ]);
  });
});
