# Development Guide

## Prerequisites
- Bun >= 1.0.0 (required — Node.js is NOT compatible)
- Git
- A text editor with TypeScript support

## Getting Set Up
```bash
git clone https://github.com/open-zk-kb/open-zk-kb
cd open-zk-kb
bun install
bun run build
bun test          # Verify everything works
```

## The Build Pipeline
- Source lives in src/, compiled output goes to dist/
- dist/ is what actually runs — both the MCP server and OpenCode plugin load from dist/
- You MUST rebuild after every source change: bun run build
- Clean rebuild when things are weird: rm -rf dist/ && bun run build
- TypeScript strict mode is enforced — the build IS the type check

## Development Loop
```
Edit src/ → bun run build → bun test → verify manually if needed
```
For rapid iteration:
- bun test --watch — re-runs tests on file change
- Note: there's no watch mode for the build itself — you need to run bun run build each time

## Project Structure
(See [architecture.md](architecture.md) for details)

```
src/
├── mcp-server.ts       # MCP server entry point (stdio transport)
├── opencode-plugin.ts  # OpenCode plugin entry (hooks, capture, injection)
├── tool-handlers.ts    # Shared logic for all 3 tools
├── storage/
│   └── NoteRepository.ts  # Core CRUD, FTS5, link tracking
├── config.ts           # Config loading (YAML with defaults)
├── schema.ts           # DB schema versioning + migrations
├── data-migrations.ts  # Agent-driven content upgrades
├── embeddings.ts       # Vector embedding support (optional)
├── logger.ts           # File-based logging (never stdout)
├── prompts.ts          # Note rendering to XML format
├── setup.ts            # CLI installer for 5 clients
├── types.ts            # TypeScript interfaces
└── utils/
    ├── path.ts         # Path expansion, XDG resolution
    └── wikilink.ts     # Wiki-link parsing
```

## Testing
The test suite uses bun:test with a shared harness.

| Command | What it does |
|---------|-------------|
| bun test | Run all tests |
| bun test tests/mcp-tools.test.ts | Run a single test file |
| bun test --watch | Watch mode |
| bun test --coverage | Coverage report |
| EVAL=1 bun test tests/eval/eval.test.ts --timeout 120000 | Agent eval suite |

### Writing Tests
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createTestHarness, cleanupTestHarness, TestContext } from './harness';

describe('My Feature', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = createTestHarness(); });
  afterEach(() => { cleanupTestHarness(ctx); });

  it('should store a note', () => {
    const result = handleStore({
      title: 'Test Note',
      content: 'Some content',
      kind: 'reference',
      summary: 'A test note',
      guidance: 'Use for testing',
    }, ctx.engine);
    expect(result).toContain('Knowledge stored');
  });
});
```

Key testing patterns:
1. Always use createTestHarness() — creates temp directory + NoteRepository, cleaned up automatically
2. Test tool handlers directly by importing from tool-handlers.ts
3. 7 built-in fixtures in tests/fixtures.ts covering: permanent, fleeting, stale, large, broken links, merge candidates, contradictions
4. The eval suite is gated behind EVAL=1 and requires 120s timeout — it tests end-to-end agent behavior

## Linting
```bash
bun run lint        # Check for issues
bun run lint:fix    # Auto-fix what's possible
```
ESLint is configured with TypeScript plugin in eslint.config.cjs.

## Debugging

### Logs
- All runtime logging goes to files at ~/.local/state/open-zk-kb/logs/ (XDG_STATE_HOME)
- Use logToFile('DEBUG', 'message', { data }, config) for debug output
- NEVER use console.log in server/plugin code — it breaks MCP stdio transport
- Exception: src/setup.ts and scripts/ are CLI tools where console output is fine

### Database
- SQLite DB is at <vault>/.index/knowledge.db
- You can inspect it directly: sqlite3 ~/.local/share/open-zk-kb/.index/knowledge.db
- Rebuild from markdown files: use the knowledge-maintain rebuild tool action
- Schema version: check with .headers on then PRAGMA user_version;

## Branch Strategy & CI

- **`main`** — Stable branch. All PRs target `main`.

| Trigger | Build + Lint + Tests | Smoke Tests |
|---------|---------------------|-------------|
| PR → `main` | ✅ | ✅ |

Smoke tests verify: install/uninstall for all 5 clients, MCP protocol, and KB round-trip.

Run locally:
```bash
bash tests/docker/smoke-test.sh
```

## Common Pitfalls
1. "My changes aren't taking effect" — Did you run bun run build? The dist/ directory is what runs, not src/.
2. "MCP server output is garbled" — You probably used console.log() somewhere. Use logToFile() instead — MCP uses stdout as its transport.
3. "FTS search returns nothing" — FTS5 index is manually managed. If you're adding notes programmatically, make sure you call ftsInsert().
4. "Tests fail with 'database is locked'" — Make sure cleanupTestHarness() is in your afterEach. Each test needs its own isolated vault.
5. "Import errors after adding a new file" — Make sure to use .js extension in imports (ESM resolution): import { foo } from './bar.js' even though the source file is .ts.

## Adding a New Tool
1. Add handler function in src/tool-handlers.ts
2. Register in src/mcp-server.ts (Zod schema + server.registerTool)
3. Register in src/opencode-plugin.ts (if applicable to plugin)
4. Add tests in tests/mcp-tools.test.ts
5. Rebuild: bun run build

## Adding a New Installer Client
1. Add entry to CLIENT_CONFIGS in src/setup.ts
2. Define: name, configPath, configFormat, mcpPath
3. Test: bun run setup install --client <name> --dry-run
