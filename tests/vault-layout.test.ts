import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  createTestHarness,
  cleanupTestHarness,
  createNoteFile,
} from './harness.js';
import type { TestContext } from './harness.js';
import { resolveNotePath, walkMarkdownFiles, extractProjectFromTags } from '../src/storage/path-resolver.js';
import { handleMaintain, handleStore } from '../src/tool-handlers.js';
import { buildIndexContent } from '../src/storage/IndexBuilder.js';
import type { NoteMetadata } from '../src/storage/NoteRepository.js';

describe('Path Resolver', () => {
  const vault = '/vault';

  it('places personalization notes in preferences/', () => {
    const result = resolveNotePath(vault, 'personalization', null, '2026042700000000', 'prefers-bun');
    expect(result).toBe('/vault/preferences/2026042700000000-prefers-bun.md');
  });

  it('places personalization in preferences/ even with project tag', () => {
    const result = resolveNotePath(vault, 'personalization', 'open-zk-kb', '2026042700000000', 'prefers-bun');
    expect(result).toBe('/vault/preferences/2026042700000000-prefers-bun.md');
  });

  it('places domain as singleton in project dir', () => {
    const result = resolveNotePath(vault, 'domain', 'open-zk-kb', '2026042700000000', 'open-zk-kb-domain');
    expect(result).toBe('/vault/projects/open-zk-kb/domain.md');
  });

  it('places index as singleton in project dir', () => {
    const result = resolveNotePath(vault, 'index', 'open-zk-kb', '2026042700000000', 'open-zk-kb-index');
    expect(result).toBe('/vault/projects/open-zk-kb/index.md');
  });

  it('places log as singleton in project dir', () => {
    const result = resolveNotePath(vault, 'log', 'open-zk-kb', '2026042700000000', 'open-zk-kb-log');
    expect(result).toBe('/vault/projects/open-zk-kb/log.md');
  });

  it('places global index at vault root', () => {
    const result = resolveNotePath(vault, 'index', null, '2026042700000000', 'knowledge-base');
    expect(result).toBe('/vault/index.md');
  });

  it('places global log at vault root', () => {
    const result = resolveNotePath(vault, 'log', null, '2026042700000000', 'operations-log');
    expect(result).toBe('/vault/log.md');
  });

  it('places decisions in project decisions/ dir', () => {
    const result = resolveNotePath(vault, 'decision', 'open-zk-kb', '2026042700000000', 'chose-fts5');
    expect(result).toBe('/vault/projects/open-zk-kb/decisions/2026042700000000-chose-fts5.md');
  });

  it('places references in project references/ dir', () => {
    const result = resolveNotePath(vault, 'reference', 'investing', '2026042700000000', 'sp500-returns');
    expect(result).toBe('/vault/projects/investing/references/2026042700000000-sp500-returns.md');
  });

  it('places observations in project observations/ dir', () => {
    const result = resolveNotePath(vault, 'observation', 'conductor', '2026042700000000', 'slack-gotcha');
    expect(result).toBe('/vault/projects/conductor/observations/2026042700000000-slack-gotcha.md');
  });

  it('places procedures in project procedures/ dir', () => {
    const result = resolveNotePath(vault, 'procedure', 'open-zk-kb', '2026042700000000', 'release-workflow');
    expect(result).toBe('/vault/projects/open-zk-kb/procedures/2026042700000000-release-workflow.md');
  });

  it('places resources in project resources/ dir', () => {
    const result = resolveNotePath(vault, 'resource', 'open-zk-kb', '2026042700000000', 'bun-docs');
    expect(result).toBe('/vault/projects/open-zk-kb/resources/2026042700000000-bun-docs.md');
  });

  it('places unscoped decisions in general/decisions/', () => {
    const result = resolveNotePath(vault, 'decision', null, '2026042700000000', 'yaml-syntax');
    expect(result).toBe('/vault/general/decisions/2026042700000000-yaml-syntax.md');
  });

  it('places unscoped observations in general/observations/', () => {
    const result = resolveNotePath(vault, 'observation', null, '2026042700000000', 'macos-quirks');
    expect(result).toBe('/vault/general/observations/2026042700000000-macos-quirks.md');
  });

  it('extracts project from tags', () => {
    expect(extractProjectFromTags(['project:foo', 'bar'])).toBe('foo');
    expect(extractProjectFromTags(['bar', 'baz'])).toBeNull();
    expect(extractProjectFromTags([])).toBeNull();
  });
});

describe('walkMarkdownFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'walk-test-'));
    fs.mkdirSync(path.join(tempDir, '.index'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'projects', 'foo', 'decisions'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'general', 'observations'), { recursive: true });

    fs.writeFileSync(path.join(tempDir, 'index.md'), '# Home');
    fs.writeFileSync(path.join(tempDir, 'projects', 'foo', 'index.md'), '# Foo');
    fs.writeFileSync(path.join(tempDir, 'projects', 'foo', 'decisions', '001-test.md'), '# Decision');
    fs.writeFileSync(path.join(tempDir, 'general', 'observations', '002-obs.md'), '# Obs');
    fs.writeFileSync(path.join(tempDir, '.index', 'should-skip.md'), 'skip me');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('recursively finds all .md files', () => {
    const files = walkMarkdownFiles(tempDir);
    expect(files.length).toBe(4);
  });

  it('skips .index/ directory', () => {
    const files = walkMarkdownFiles(tempDir);
    const basenames = files.map(f => path.basename(f));
    expect(basenames).not.toContain('should-skip.md');
  });

  it('includes files from nested directories', () => {
    const files = walkMarkdownFiles(tempDir);
    const basenames = files.map(f => path.basename(f));
    expect(basenames).toContain('001-test.md');
    expect(basenames).toContain('002-obs.md');
  });
});

describe('Structured Vault Storage', () => {
  let context: TestContext;

  beforeEach(() => {
    context = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(context);
  });

  it('stores a decision in projects/{project}/decisions/', () => {
    const result = context.engine.store('Chose FTS5 over trigram search', {
      title: 'Chose FTS5',
      kind: 'decision',
      status: 'permanent',
      tags: ['project:open-zk-kb'],
    });

    expect(result.path).toContain('projects/open-zk-kb/decisions/');
    expect(result.path).toEndWith('.md');
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('stores personalization in preferences/', () => {
    const result = context.engine.store('User prefers dark mode', {
      title: 'Dark Mode',
      kind: 'personalization',
      status: 'permanent',
      tags: ['project:some-project'],
    });

    expect(result.path).toContain('/preferences/');
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('stores unscoped observation in general/observations/', () => {
    const result = context.engine.store('macOS keychain is weird', {
      title: 'macOS Quirk',
      kind: 'observation',
    });

    expect(result.path).toContain('general/observations/');
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('creates directories on demand', () => {
    const decisionsDir = path.join(context.tempDir, 'projects', 'new-project', 'decisions');
    expect(fs.existsSync(decisionsDir)).toBe(false);

    context.engine.store('New decision', {
      title: 'First Decision',
      kind: 'decision',
      tags: ['project:new-project'],
    });

    expect(fs.existsSync(decisionsDir)).toBe(true);
  });

  it('preserves directory on update (birthplace-only)', () => {
    const result = context.engine.store('Original content', {
      title: 'Test Note',
      kind: 'reference',
      tags: ['project:alpha'],
    });

    expect(result.path).toContain('projects/alpha/references/');
    const originalDir = path.dirname(result.path);

    const updated = context.engine.store('Updated content', {
      existingId: result.id,
      title: 'Test Note Updated',
      kind: 'reference',
      tags: ['project:beta'],
    });

    expect(path.dirname(updated.path)).toBe(originalDir);
  });
});

describe('rebuildFromFiles with structured layout', () => {
  let context: TestContext;

  beforeEach(() => {
    context = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(context);
  });

  it('indexes files from structured directories', () => {
    context.engine.store('Decision content', {
      title: 'Test Decision',
      kind: 'decision',
      tags: ['project:myproject'],
    });

    context.engine.store('Observation content', {
      title: 'Test Observation',
      kind: 'observation',
    });

    const result = context.engine.rebuildFromFiles();
    expect(result.indexed).toBeGreaterThanOrEqual(2);
    expect(result.errors).toBe(0);
  });

  it('handles mixed flat and structured files', () => {
    context.engine.store('Structured note', {
      title: 'Structured',
      kind: 'decision',
      tags: ['project:test'],
    });

    createNoteFile(context, '2026042700000099', `---
id: 2026042700000099
title: Legacy Flat Note
kind: observation
status: fleeting
lifecycle: living
type: atomic
tags:
created: 2026-04-27
updated: 2026-04-27
---

Legacy content in flat root`);

    const result = context.engine.rebuildFromFiles();
    expect(result.indexed).toBeGreaterThanOrEqual(2);

    const flatNote = context.engine.getById('2026042700000099');
    expect(flatNote).not.toBeNull();
    expect(flatNote!.title).toBe('Legacy Flat Note');
  });
});

describe('migrate-layout', () => {
  let context: TestContext;

  beforeEach(() => {
    context = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(context);
  });

  it('dry run shows planned moves without changing files', async () => {
    const flatFilename = '2026042700000001-flat-decision.md';
    const flatPath = createNoteFile(context, '2026042700000001', `---
id: 2026042700000001
title: Flat Decision
kind: decision
status: permanent
lifecycle: snapshot
type: atomic
tags:
  - project:myproject
created: 2026-04-27
updated: 2026-04-27
---

Decision content`, flatFilename);

    context.engine.rebuildFromFiles();

    const output = await handleMaintain(
      { action: 'migrate-layout', dryRun: true } as any,
      context.engine,
      context.config,
    );

    expect(output).toContain('Dry Run');
    expect(output).toContain('Would move');
    expect(output).toContain('projects/myproject/decisions/');
    expect(fs.existsSync(flatPath)).toBe(true);
  });

  it('actual migration moves files and rebuilds DB', async () => {
    createNoteFile(context, '2026042700000002', `---
id: 2026042700000002
title: Moveable Note
kind: observation
status: fleeting
lifecycle: living
type: atomic
tags:
  - project:testproj
created: 2026-04-27
updated: 2026-04-27
---

Observation content`, '2026042700000002-moveable-note.md');

    context.engine.rebuildFromFiles();

    const output = await handleMaintain(
      { action: 'migrate-layout', dryRun: false } as any,
      context.engine,
      context.config,
    );

    expect(output).toContain('Moved: 1');
    expect(output).toContain('Post-migration rebuild');

    const note = context.engine.getById('2026042700000002');
    expect(note).not.toBeNull();
    expect(note!.path).toContain('projects/testproj/observations/');
    expect(fs.existsSync(note!.path)).toBe(true);
  });

  it('skips notes already in correct location', async () => {
    context.engine.store('Already structured', {
      title: 'Structured Note',
      kind: 'decision',
      tags: ['project:proj'],
    });

    const output = await handleMaintain(
      { action: 'migrate-layout', dryRun: true } as any,
      context.engine,
      context.config,
    );

    expect(output).toContain('Already in place: 1');
  });
});

describe('Global Navigation', () => {
  let context: TestContext;

  beforeEach(() => {
    context = createTestHarness();
  });

  afterEach(() => {
    cleanupTestHarness(context);
  });

  it('generates global index.md on store', () => {
    handleStore(
      { title: 'Test Note', content: 'Content', kind: 'decision', project: 'myproject', summary: 'A decision', guidance: 'Use it' } as any,
      context.engine,
      null,
      context.config,
    );

    const globalIndex = path.join(context.tempDir, 'index.md');
    expect(fs.existsSync(globalIndex)).toBe(true);
    const content = fs.readFileSync(globalIndex, 'utf-8');
    expect(content).toContain('# Knowledge Base');
    expect(content).toContain('myproject');
  });

  it('generates global log.md on store', () => {
    handleStore(
      { title: 'Logged Note', content: 'Content', kind: 'observation', project: 'proj', summary: 'Obs', guidance: 'Note it' } as any,
      context.engine,
      null,
      context.config,
    );

    const globalLog = path.join(context.tempDir, 'log.md');
    expect(fs.existsSync(globalLog)).toBe(true);
    const content = fs.readFileSync(globalLog, 'utf-8');
    expect(content).toContain('# Operations Log');
    expect(content).toContain('[proj]');
  });

  it('generates review.md with fleeting notes', () => {
    handleStore(
      { title: 'Fleeting Obs', content: 'Content', kind: 'observation', project: 'proj', summary: 'Temp', guidance: 'Review' } as any,
      context.engine,
      null,
      context.config,
    );

    const reviewPath = path.join(context.tempDir, 'review.md');
    expect(fs.existsSync(reviewPath)).toBe(true);
    const content = fs.readFileSync(reviewPath, 'utf-8');
    expect(content).toContain('Needs Review');
    expect(content).toContain('observation');
  });

  it('generates general/index.md for unscoped notes', () => {
    handleStore(
      { title: 'General Note', content: 'Unscoped content', kind: 'reference', summary: 'General ref', guidance: 'Use it' } as any,
      context.engine,
      null,
      context.config,
    );

    const generalIndex = path.join(context.tempDir, 'general', 'index.md');
    expect(fs.existsSync(generalIndex)).toBe(true);
    const content = fs.readFileSync(generalIndex, 'utf-8');
    expect(content).toContain('# General Knowledge');
  });

  it('appends to global log on subsequent stores', () => {
    handleStore(
      { title: 'First', content: 'A', kind: 'decision', project: 'p1', summary: 'First', guidance: 'G' } as any,
      context.engine,
      null,
      context.config,
    );
    handleStore(
      { title: 'Second', content: 'B', kind: 'observation', project: 'p2', summary: 'Second', guidance: 'G' } as any,
      context.engine,
      null,
      context.config,
    );

    const globalLog = path.join(context.tempDir, 'log.md');
    const content = fs.readFileSync(globalLog, 'utf-8');
    expect(content).toContain('[p1]');
    expect(content).toContain('[p2]');
  });
});

describe('MOC Splitting', () => {
  function makeFakeNote(id: string, kind: string, title: string): NoteMetadata {
    return {
      id,
      path: `/vault/projects/test/${kind}s/${id}-${title.toLowerCase().replace(/\s/g, '-')}.md`,
      title,
      kind: kind as any,
      status: 'permanent',
      lifecycle: 'living',
      type: 'atomic',
      tags: ['project:test'],
      content: 'test content',
      summary: `Summary of ${title}`,
      created_at: Date.now(),
      updated_at: Date.now(),
      word_count: 10,
    };
  }

  it('does not split when below threshold', () => {
    const notes = [
      makeFakeNote('001', 'decision', 'Dec 1'),
      makeFakeNote('002', 'decision', 'Dec 2'),
      makeFakeNote('003', 'observation', 'Obs 1'),
    ];

    const { content, subMocs } = buildIndexContent('test', notes, { threshold: 30, previewCount: 5 });
    expect(subMocs).toHaveLength(0);
    expect(content).toContain('## Decisions (2)');
    expect(content).toContain('Dec 1');
    expect(content).toContain('Dec 2');
  });

  it('splits large kinds into sub-MOCs when threshold exceeded', () => {
    const notes: NoteMetadata[] = [];
    for (let i = 0; i < 10; i++) {
      notes.push(makeFakeNote(`d${i}`, 'decision', `Decision ${i}`));
    }
    for (let i = 0; i < 10; i++) {
      notes.push(makeFakeNote(`r${i}`, 'reference', `Reference ${i}`));
    }
    for (let i = 0; i < 10; i++) {
      notes.push(makeFakeNote(`o${i}`, 'observation', `Observation ${i}`));
    }
    for (let i = 0; i < 3; i++) {
      notes.push(makeFakeNote(`p${i}`, 'procedure', `Procedure ${i}`));
    }

    const { content, subMocs } = buildIndexContent('test', notes, { threshold: 30, previewCount: 3 });

    expect(subMocs.length).toBe(3);
    const subMocKinds = subMocs.map(s => s.kind).sort();
    expect(subMocKinds).toEqual(['decision', 'observation', 'reference']);

    expect(content).toContain('View all 10');
    expect(content).toContain('## Procedures (3)');
    expect(content).not.toContain('View all 3');
  });

  it('sub-MOC contains back-link to parent', () => {
    const notes: NoteMetadata[] = [];
    for (let i = 0; i < 35; i++) {
      notes.push(makeFakeNote(`n${i}`, 'decision', `Decision ${i}`));
    }

    const { subMocs } = buildIndexContent('myproj', notes, { threshold: 30, previewCount: 5 });
    expect(subMocs.length).toBe(1);
    expect(subMocs[0].content).toContain('Back to Myproj');
    expect(subMocs[0].content).toContain('projects/myproj/index');
    expect(subMocs[0].content).toContain('Decision 0');
  });

  it('keeps small kinds inline even when project exceeds threshold', () => {
    const notes: NoteMetadata[] = [];
    for (let i = 0; i < 28; i++) {
      notes.push(makeFakeNote(`d${i}`, 'decision', `Decision ${i}`));
    }
    notes.push(makeFakeNote('r1', 'resource', 'Single Resource'));
    notes.push(makeFakeNote('r2', 'resource', 'Second Resource'));

    const { content, subMocs } = buildIndexContent('test', notes, { threshold: 30, previewCount: 5 });

    expect(subMocs.length).toBe(1);
    expect(subMocs[0].kind).toBe('decision');
    expect(content).toContain('## Resources (2)');
    expect(content).toContain('Single Resource');
  });
});
