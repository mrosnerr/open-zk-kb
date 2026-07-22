import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleStore, handleTemplate, handleHealth } from '../src/tool-handlers.js';
import { cleanupTestHarness, createTestHarness, sleep, type TestContext } from './harness.js';
import {
  getTemplate, getTemplatesDir, getExpectedCategories, matchCategories,
  extractHeaders, stripExamplesBlock, CONFORMANCE_KINDS, CATEGORY_MAPS,
} from '../src/template-handler.js';

const ALL_KINDS = ['decision', 'procedure', 'observation', 'domain', 'reference', 'resource', 'personalization', 'log'];

describe('template files', () => {
  it('all 8 kind templates exist on disk', () => {
    const dir = getTemplatesDir();
    for (const kind of ALL_KINDS) {
      const filePath = path.join(dir, `${kind}.md`);
      expect(fs.existsSync(filePath)).toBe(true);
    }
  });

  it('structured kinds have <examples> blocks', () => {
    const dir = getTemplatesDir();
    for (const kind of ['decision', 'procedure', 'observation', 'domain', 'reference']) {
      const content = fs.readFileSync(path.join(dir, `${kind}.md`), 'utf-8');
      expect(content).toContain('<examples>');
      expect(content).toContain('<example variant="correct">');
      expect(content).toContain('<example variant="incorrect">');
      expect(content).toContain('<rationale>');
    }
  });

  it('exempt kinds have no <examples> blocks', () => {
    const dir = getTemplatesDir();
    for (const kind of ['resource', 'personalization']) {
      const content = fs.readFileSync(path.join(dir, `${kind}.md`), 'utf-8');
      expect(content).not.toContain('<examples>');
    }
  });
});

describe('getTemplate', () => {
  it('returns package template wrapped in source tag', () => {
    const result = getTemplate('decision');
    expect(result).toContain('<template_content source="package">');
    expect(result).toContain('## Context');
    expect(result).toContain('</template_content>');
  });

  it('returns error string for nonexistent kind', () => {
    const result = getTemplate('nonexistent');
    expect(result).toContain('No template found');
  });

  it('returns project override when path exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tpl-test-'));
    const overridePath = path.join(tmpDir, 'decision.md');
    fs.writeFileSync(overridePath, '## Custom Decision Template\n');

    const result = getTemplate('decision', overridePath);
    expect(result).toContain('<template_content source="project-override">');
    expect(result).toContain('Custom Decision Template');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('falls back to package when override path does not exist', () => {
    const result = getTemplate('decision', '/nonexistent/path/decision.md');
    expect(result).toContain('<template_content source="package">');
  });
});

describe('handleTemplate', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness({ telemetryEnabled: true }); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('returns template for valid kind', () => {
    const result = handleTemplate({ kind: 'procedure' }, ctx.engine);
    expect(result).toContain('## Trigger');
    expect(result).toContain('## Steps');
  });

  it('records telemetry on invocation', async () => {
    handleTemplate({ kind: 'decision' }, ctx.engine);
    await sleep(0);

    const rows = ctx.engine.getTelemetryRows();
    expect(rows.some(r => r.tool_name === 'template' && r.arg_kind === 'decision')).toBe(true);
  });
});

describe('stripExamplesBlock', () => {
  it('removes examples section from content', () => {
    const content = '## Context\nSome text\n\n<examples>\n## Options\nExample content\n</examples>\n\n## Decision\nMore text';
    const result = stripExamplesBlock(content);
    expect(result).toContain('## Context');
    expect(result).toContain('## Decision');
    expect(result).not.toContain('<examples>');
    expect(result).not.toContain('## Options');
  });

  it('handles content with no examples block', () => {
    const content = '## Context\nText here\n\n## Decision\nChosen X';
    expect(stripExamplesBlock(content)).toBe(content.trim());
  });
});

describe('extractHeaders', () => {
  it('extracts level-2 headers lowercased', () => {
    const content = '## Context\ntext\n## Options Considered\ntext\n### Subheading\ntext';
    expect(extractHeaders(content)).toEqual(['context', 'options considered']);
  });

  it('returns empty array for headerless content', () => {
    expect(extractHeaders('Just plain text')).toEqual([]);
  });
});

describe('semantic header matching', () => {
  it('matches exact category names', () => {
    const categories = CATEGORY_MAPS.decision;
    const headers = ['context', 'options considered', 'decision', 'tradeoffs accepted', 'consequences', 'reversibility'];
    const matched = matchCategories(categories, headers);
    expect(matched.size).toBe(6);
  });

  it('matches synonym "alternatives" to options category', () => {
    const categories = CATEGORY_MAPS.decision;
    const matched = matchCategories(categories, ['alternatives']);
    expect(matched.has('options')).toBe(true);
  });

  it('matches "trade-offs" to tradeoffs category', () => {
    const categories = CATEGORY_MAPS.decision;
    const matched = matchCategories(categories, ['trade-offs']);
    expect(matched.has('tradeoffs')).toBe(true);
  });

  it('matches "what happened" to what category (observation)', () => {
    const categories = CATEGORY_MAPS.observation;
    const matched = matchCategories(categories, ['what happened']);
    expect(matched.has('what')).toBe(true);
  });

  it('returns empty set for unrecognized headers', () => {
    const categories = CATEGORY_MAPS.decision;
    const matched = matchCategories(categories, ['banana', 'pineapple']);
    expect(matched.size).toBe(0);
  });
});

describe('getExpectedCategories', () => {
  it('returns categories for conformance kinds', () => {
    for (const kind of CONFORMANCE_KINDS) {
      expect(getExpectedCategories(kind)).not.toBeNull();
    }
  });

  it('returns null for exempt kinds', () => {
    expect(getExpectedCategories('personalization')).toBeNull();
    expect(getExpectedCategories('resource')).toBeNull();
    expect(getExpectedCategories('index')).toBeNull();
    expect(getExpectedCategories('log')).toBeNull();
  });
});

describe('conformance check in handleStore', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness({ telemetryEnabled: true }); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('emits hint when 0% coverage (no headers)', async () => {
    const result = await handleStore({
      title: 'Flat decision',
      content: 'We chose X because it seemed good.',
      kind: 'decision',
      summary: 'Chose X',
      guidance: 'Use X',
    }, ctx.engine, null, ctx.config);

    expect(result).toContain('no headings found');
    expect(result).toContain('0%');
  });

  it('emits hint with missing categories when coverage < 50%', async () => {
    const result = await handleStore({
      title: 'Partial decision',
      content: '## Context\nWe needed to decide.\n\n## Decision\nPicked option A.',
      kind: 'decision',
      summary: 'Picked A',
      guidance: 'Use A',
    }, ctx.engine, null, ctx.config);

    expect(result).toContain('Missing:');
    expect(result).toContain('Conformance:');
  });

  it('no hint when coverage >= 50%', async () => {
    const result = await handleStore({
      title: 'Good decision',
      content: '## Context\nNeeded to choose.\n\n## Options Considered\nA vs B.\n\n## Decision\nPicked A.\n\n## Tradeoffs\nLose B benefits.',
      kind: 'decision',
      summary: 'Picked A over B',
      guidance: 'Use A',
    }, ctx.engine, null, ctx.config);

    expect(result).not.toContain('Conformance:');
    expect(result).not.toContain('Missing:');
  });

  it('no hint for exempt kinds regardless of structure', async () => {
    const result = await handleStore({
      title: 'Simple preference',
      content: 'I like dark mode.',
      kind: 'personalization',
      summary: 'Prefers dark mode',
      guidance: 'Use dark mode',
    }, ctx.engine, null, ctx.config);

    expect(result).not.toContain('knowledge-template');
  });
});

describe('conformance telemetry', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness({ telemetryEnabled: true }); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('recordConformance persists to database', async () => {
    ctx.engine.recordConformance({
      noteId: '2026050100000000',
      kind: 'decision',
      action: 'created',
      model: 'test-model',
      coverage: 0.67,
      matchedCategories: ['context', 'options', 'decision', 'tradeoffs'],
      missingCategories: ['consequences', 'reversibility'],
      hintTriggered: false,
    });

    const agg = ctx.engine.getConformanceAggregates(30);
    expect(agg.totalChecked).toBe(1);
    expect(agg.avgCoverage).toBeCloseTo(0.67, 1);
    expect(agg.hintCount).toBe(0);
    expect(agg.byKind.decision).toBeDefined();
    expect(agg.byKind.decision.count).toBe(1);
  });

  it('getConformanceAggregates computes averages across kinds', async () => {
    ctx.engine.recordConformance({
      noteId: '2026050100000001', kind: 'decision', action: 'created',
      model: null, coverage: 0.8, matchedCategories: [], missingCategories: [], hintTriggered: false,
    });
    ctx.engine.recordConformance({
      noteId: '2026050100000002', kind: 'procedure', action: 'created',
      model: null, coverage: 0.6, matchedCategories: [], missingCategories: [], hintTriggered: true,
    });

    const agg = ctx.engine.getConformanceAggregates(30);
    expect(agg.totalChecked).toBe(2);
    expect(agg.avgCoverage).toBeCloseTo(0.7, 1);
    expect(agg.hintCount).toBe(1);
    expect(agg.hintTriggerRate).toBeCloseTo(0.5, 1);
  });

  it('conformance stats appear in knowledge-health with --telemetry', async () => {
    await handleStore({
      title: 'Bare decision',
      content: 'No structure at all.',
      kind: 'decision',
      summary: 'Test',
      guidance: 'Test',
    }, ctx.engine, null, ctx.config);
    await sleep(0);

    const stats = await handleHealth({ telemetry: true }, ctx.engine, ctx.config);
    expect(stats).toContain('Template Conformance');
    expect(stats).toContain('Stores checked:');
  });
});
