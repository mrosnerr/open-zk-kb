// tests/eval/eval.test.ts - bun:test entry point for agent eval suite
// Skipped unless EVAL=1. Runs scenarios against all available CLIs.
// Usage: EVAL=1 bun test tests/eval/eval.test.ts --timeout 120000

import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { runScenario, isCliAvailable, type CLIAdapter } from './harness.js';
import { coreKbScenarios } from './features/core-kb.eval.js';

const SKIP = !process.env.EVAL;

const CLIS: CLIAdapter[] = (['claude', 'opencode'] as CLIAdapter[]).filter(isCliAvailable);

describe.skipIf(SKIP)('Agent Eval Suite', () => {
  beforeAll(() => {
    const distPath = resolve(import.meta.dir, '../../dist/mcp-server.js');
    if (!existsSync(distPath)) {
      throw new Error('dist/ not built. Run: bun run build');
    }

    if (CLIS.length === 0) {
      throw new Error('No CLI available. Install claude or opencode.');
    }
  });

  for (const cli of CLIS) {
    describe(cli, () => {
      describe('core-kb', () => {
        for (const scenario of coreKbScenarios) {
          it(scenario.name, async () => {
            const result = await runScenario(scenario, cli);

            if (!result.passed) {
              console.log(`\n--- ${scenario.name} (${cli}) raw response ---`);
              console.log(result.rawResponse);
              console.log(`--- response failures: ${result.responseFailures.join('; ') || 'none'}`);
              console.log(`--- vault failures: ${result.vaultFailures.join('; ') || 'none'}`);
              console.log(`--- duration: ${result.duration}ms ---\n`);
            }

            expect(result.responseFailures).toEqual([]);
            expect(result.vaultFailures).toEqual([]);
          }, scenario.timeout || 60_000);
        }
      });
    });
  }
});
