import { describe, expect, it } from 'bun:test';
import {
  evaluateScreeningCandidate,
  reviewedOperationTokens,
  type ScreeningCandidate,
  type ScreeningSnapshot,
} from '../src/reviewed-storage.js';

const BENCH = Boolean(process.env.BENCH);

function candidate(index = 0): ScreeningCandidate {
  return {
    title: `Reviewed candidate ${index}`,
    content: `durable reviewed candidate content ${index}`,
    kind: 'reference',
    summary: `Durable reviewed candidate summary ${index}.`,
    guidance: `Use reviewed candidate ${index}.`,
    status: 'fleeting',
    lifecycle: 'living',
    tags: ['project:bench'],
    related: [],
  };
}

function snapshot(): ScreeningSnapshot {
  return {
    schemaVersion: 1,
    notes: Array.from({ length: 1_000 }, (_, index) => ({
      id: String(index).padStart(16, '0'),
      title: `Existing note ${index}`,
      normalizedTitle: `existing note ${index}`,
      content: `existing content ${index}`,
      summary: `Existing summary ${index}.`,
      guidance: `Use existing note ${index}.`,
      kind: 'reference' as const,
      status: 'fleeting' as const,
      lifecycle: 'living' as const,
      tags: ['project:bench'],
      related: [],
      updatedAt: index,
      contentHash: BigInt(index).toString(16).padStart(16, '0'),
      hashSource: 'stored' as const,
    })),
  };
}

describe.skipIf(!BENCH)('reviewed storage performance budgets', () => {
  it('screens one candidate against 1,000 copied notes within 250ms', () => {
    const copied = snapshot();
    const run = () => evaluateScreeningCandidate(candidate(), copied);
    for (let index = 0; index < 3; index++) run();
    const measurements = Array.from({ length: 5 }, () => {
      const start = performance.now();
      run();
      return performance.now() - start;
    });
    expect(measurements.every(elapsed => elapsed < 250)).toBe(true);
  });

  it('evaluates and tokenizes an ordered 50-candidate by 1,000-note plan within 1,500ms', () => {
    const copied = snapshot();
    const candidates = Array.from({ length: 50 }, (_, index) => candidate(index));
    const run = () => candidates.map(item => {
      const evaluation = evaluateScreeningCandidate(item, copied);
      return reviewedOperationTokens({ candidate: item, evaluation, snapshotVersion: copied.schemaVersion, configVersion: 'benchmark' });
    });
    for (let index = 0; index < 3; index++) run();
    const measurements = Array.from({ length: 5 }, () => {
      const start = performance.now();
      run();
      return performance.now() - start;
    });
    expect(measurements.every(elapsed => elapsed < 1_500)).toBe(true);
  });
});
