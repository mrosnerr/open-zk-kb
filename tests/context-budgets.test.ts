import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { FALLBACK_KNOWLEDGE_GUIDANCE } from '../src/pi/extension.js';
import { buildPreferenceCapsule, handleContext, handleSearch } from '../src/tool-handlers.js';
import { TOOL_DEFINITIONS } from '../src/tool-meta.js';
import { cleanupTestHarness, createTestHarness } from './harness.js';

const root = path.resolve(import.meta.dir, '..');

function wordCount(value: string): number {
  return value.split(/\s+/).filter(word => /[A-Za-z0-9]/.test(word)).length;
}

function byteCount(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

describe('session context contribution baselines', () => {
  it('measures every managed, automatic, explicit, and search surface', () => {
    const ctx = createTestHarness();
    try {
      for (let index = 0; index < 13; index++) {
        ctx.engine.store(`Preference ${index + 1}`, {
          title: `Preference ${index + 1}`,
          kind: 'personalization',
          status: 'permanent',
          tags: index % 2 === 0 ? ['scope:global'] : ['project:budget-project', 'client:pi'],
          guidance: `Keep preference ${index + 1} concise.`,
        });
      }
      for (let index = 0; index < 6; index++) {
        ctx.engine.store(`budget-keyword ${'full detail '.repeat(80)}${index}`, {
          title: `Budget reference ${index + 1}`,
          kind: 'reference',
          status: 'permanent',
          tags: ['project:budget-project'],
          summary: `Budget summary ${index + 1}`,
          guidance: `Use budget reference ${index + 1}.`,
        });
      }

      const policy = fs.readFileSync(path.join(root, 'templates/install/agent-instructions-full.md'), 'utf8');
      const canonicalPolicy = policy.split('\n').filter(line => !line.startsWith('**Client pointer:**')).join('\n');
      const capsule = buildPreferenceCapsule(ctx.engine, { project: 'budget-project', client: 'pi' });
      const overview = handleContext({ project: 'budget-project', logEntries: 5 }, ctx.engine, ctx.config);
      const compactText = handleSearch({ project: 'budget-project', client: 'pi', query: 'budget-keyword', mode: 'compact' }, ctx.engine, null, ctx.config);
      const fullText = handleSearch({ project: 'budget-project', client: 'pi', query: 'budget-keyword', mode: 'full' }, ctx.engine, null, ctx.config);
      const compact = JSON.parse(compactText) as { count: number; results: unknown[] };

      const measurements = {
        managedPolicy: { words: wordCount(canonicalPolicy), bytes: byteCount(canonicalPolicy) },
        piFallback: { words: wordCount(FALLBACK_KNOWLEDGE_GUIDANCE), bytes: byteCount(FALLBACK_KNOWLEDGE_GUIDANCE) },
        registeredToolMetadata: { tools: TOOL_DEFINITIONS.length, bytes: byteCount(JSON.stringify(TOOL_DEFINITIONS)) },
        automaticPreferences: { resultCount: capsule.selected, estimatedTokens: capsule.estimatedTokens, bytes: byteCount(capsule.text) },
        explicitProjectContext: { words: wordCount(overview), bytes: byteCount(overview) },
        compactSearch: { resultCount: compact.count, bytes: byteCount(compactText) },
        fullSearch: { bytes: byteCount(fullText) },
      };

      expect(measurements.managedPolicy.words).toBeLessThanOrEqual(200);
      expect(measurements.managedPolicy.bytes).toBeGreaterThan(0);
      expect(measurements.piFallback.words).toBeLessThanOrEqual(60);
      expect(measurements.registeredToolMetadata).toEqual({
        tools: 10,
        bytes: expect.any(Number),
      });
      expect(measurements.registeredToolMetadata.bytes).toBeGreaterThan(0);
      expect(measurements.automaticPreferences.resultCount).toBe(12);
      expect(measurements.automaticPreferences.estimatedTokens).toBeLessThanOrEqual(800);
      expect(measurements.explicitProjectContext.bytes).toBeGreaterThan(0);
      expect(measurements.compactSearch.resultCount).toBe(5);
      expect(compact.results).toHaveLength(5);
      expect(measurements.compactSearch.bytes).toBeLessThan(measurements.fullSearch.bytes);
    } finally {
      cleanupTestHarness(ctx);
    }
  });
});
