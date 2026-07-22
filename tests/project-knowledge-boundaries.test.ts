import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { cleanupTestHarness, createTestHarness, type TestContext } from './harness.js';
import { parseKnowledgeApplicability } from '../src/knowledge-scope.js';

describe('repository project knowledge boundaries', () => {
  let context: TestContext;

  beforeEach(() => { context = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(context); });

  function store(title: string, tags: string[], content = 'shared boundary keyword') {
    return context.engine.store(content, { title, kind: 'reference', tags });
  }

  it('classifies explicit applicability and conflicts', () => {
    expect(parseKnowledgeApplicability(['project:alpha'])).toEqual({ type: 'project-local', project: 'alpha' });
    expect(parseKnowledgeApplicability(['scope:global'])).toEqual({ type: 'global' });
    expect(parseKnowledgeApplicability([])).toEqual({ type: 'unclassified', reason: 'missing' });
    expect(parseKnowledgeApplicability(['project:a', 'project:b'])).toEqual({ type: 'unclassified', reason: 'multiple-projects' });
    expect(parseKnowledgeApplicability(['project:a', 'scope:global'])).toEqual({ type: 'unclassified', reason: 'conflict' });
  });

  it('excludes unrelated and unclassified notes before FTS limits', () => {
    for (let index = 0; index < 4; index++) store(`Beta ${index}`, ['project:beta'], `boundary boundary boundary ${index}`);
    const alpha = store('Alpha', ['project:alpha'], 'boundary');
    const global = store('Global', ['scope:global'], 'boundary');
    store('Legacy', [], 'boundary boundary');

    const results = context.engine.search('boundary', { limit: 10, visibility: { project: 'alpha' } });
    expect(results.map(note => note.id).sort()).toEqual([alpha.id, global.id].sort());
    expect(context.engine.search('boundary', { limit: 1, visibility: { project: 'alpha' } })).toHaveLength(1);
  });

  it('prefilters vector candidates and applies client compatibility', () => {
    const alpha = store('Alpha Pi', ['project:alpha', 'client:pi']);
    const beta = store('Beta', ['project:beta']);
    const global = store('Global all', ['scope:global', 'client:all']);
    context.engine.storeEmbedding(alpha.id, [0.8, 0.2], 'test');
    context.engine.storeEmbedding(beta.id, [1, 0], 'test');
    context.engine.storeEmbedding(global.id, [0.7, 0.3], 'test');

    const results = context.engine.searchVector([1, 0], { limit: 5, visibility: { project: 'alpha', client: 'pi' } });
    expect(results.map(note => note.id)).toEqual([alpha.id, global.id]);
    expect(context.engine.searchVector([1, 0], { visibility: { project: 'alpha', client: 'cursor' } }).map(note => note.id)).toEqual([global.id]);
  });

  it('uses project-plus-global visibility for health aggregates', () => {
    const alpha = store('Alpha health', ['project:alpha']);
    const global = store('Global health', ['scope:global']);
    store('Beta health', ['project:beta']);
    store('Legacy health', []);
    store('Conflicted health', ['project:alpha', 'scope:global']);
    context.engine.storeEmbedding(alpha.id, [1, 0], 'test-model');

    expect(context.engine.getStats('alpha')).toMatchObject({ total: 2, fleeting: 2 });
    expect(context.engine.getEmbeddingStats('alpha')).toEqual({
      total: 2,
      withEmbedding: 1,
      withoutEmbedding: 1,
      models: { 'test-model': 1 },
    });
    expect(context.engine.getGrowthByKind(Date.now() - 60_000, 'alpha')).toEqual({ reference: 2 });
    const staleness = context.engine.getStalenessDistribution('alpha');
    expect(staleness.fresh + staleness.recent + staleness.aging + staleness.stale).toBe(2);
    expect(context.engine.getByIdVisible(global.id, { project: 'alpha' })?.id).toBe(global.id);
  });

  it('scopes exact IDs, duplicate candidates, and link queries', () => {
    const alpha = store('Alpha', ['project:alpha']);
    const beta = store('Beta', ['project:beta']);
    const global = store('Global', ['scope:global']);
    context.engine.updateContentHash(alpha.id, '0000000000000001');
    context.engine.updateContentHash(beta.id, '0000000000000001');
    context.engine.updateContentHash(global.id, '0000000000000001');

    const visibility = { project: 'alpha' };
    expect(context.engine.getByIdVisible(beta.id, visibility)).toBeNull();
    expect(context.engine.getByIdVisible(global.id, visibility)?.id).toBe(global.id);
    expect(context.engine.findNearDuplicates('0000000000000001', 0, visibility).map(note => note.id).sort())
      .toEqual([alpha.id, global.id].sort());

    context.engine.store(`Links [[${beta.id}]] and [[${global.id}]]`, {
      title: 'Source', kind: 'reference', tags: ['project:alpha'],
    });
    const source = context.engine.search('Links', { visibility })[0];
    expect(context.engine.getOutgoingLinks(source.id, visibility).map(link => link.note.id)).toEqual([global.id]);
  });
});
