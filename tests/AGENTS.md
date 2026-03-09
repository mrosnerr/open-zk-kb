# tests/ — Test Suite

## Overview

`bun:test` suite with shared harness, fixtures, and an agent eval framework. Tests storage, MCP tools, and end-to-end agent behavior.

## Structure

```
tests/
├── setup.ts               # Exports bun:test globals, sets NODE_ENV=test
├── harness.ts             # TestContext: temp dirs, NoteRepository lifecycle, file helpers
├── fixtures.ts            # 5 note fixtures + 2 content snippets
├── mcp-tools.test.ts      # Tests handleStore/Search/Maintain via tool-handlers.ts
├── integration.test.ts    # NoteRepository direct: kind defaults, frontmatter, search filters
├── edge-cases.test.ts     # FTS5 edge cases (operators, injection, unicode) + input validation
├── embeddings.test.ts     # Pure functions: cosineSimilarity, blob round-trip, buildEmbeddingText
├── simhash.test.ts        # SimHash duplicate detection
├── config.test.ts         # Config loading: defaults, YAML override, partial, malformed
├── schema.test.ts         # DB schema: fresh creation, migrations v1→v5
├── setup.test.ts          # CLI installer: install, uninstall, instruction injection
├── knowledge-quality-assessment.test.ts  # Content quality scoring
├── injection-quality-test.ts  # Agent self-search quality via MCP
├── docker/                # Docker-based integration tests
│   ├── smoke-test.sh      # Full install/uninstall + MCP protocol + KB round-trip
│   ├── mcp-protocol-test.ts   # MCP protocol compliance
│   ├── model-smoke-test.ts    # Local model quality validation
│   └── Dockerfile
└── eval/                  # Agent evaluation suite (EVAL=1 to enable)
    ├── eval.test.ts       # Entry — describe.skipIf(!process.env.EVAL)
    ├── harness.ts         # Isolated vaults + CLI adapters (claude/opencode)
    ├── vaults.ts          # Vault setup helpers
    └── features/
        └── core-kb.eval.ts  # 10+ EvalScenario definitions
```

## How to Write Tests

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createTestHarness, cleanupTestHarness, TestContext } from './harness';

describe('My Feature', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should do something', () => {
    const result = handleStore({ title: 'Test', content: '...', kind: 'reference' }, ctx.engine);
    expect(result).toContain('Knowledge stored');
  });
});
```

## Key Patterns

- **Always use `createTestHarness()`** — creates temp dir + NoteRepository, cleaned up in afterEach
- **Test handlers directly** — import from `tool-handlers.ts`, pass `ctx.engine`
- **Fixtures are realistic** — 5 fixtures cover: permanent, fleeting, stale, large, broken links
- **File helpers**: `createNoteFile()`, `readNoteFile()`, `noteFileExists()`, `listNoteFiles()`, `getNoteCount()`
- **Eval suite is gated**: Only runs with `EVAL=1` env var, 120s timeout

## Eval Scenarios

Each `EvalScenario` has: `setup()` → `prompt` → `responseCriteria` (mustContain/mustNotContain) + optional `vaultCriteria` for post-execution state checks.

## Commands

```bash
bun test                          # All tests
bun test tests/mcp-tools.test.ts  # Single file
bun test --watch                  # Watch mode
EVAL=1 bun test tests/eval/eval.test.ts --timeout 120000  # Eval suite
```
