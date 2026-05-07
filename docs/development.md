# Development Guide

## Prerequisites
- Bun >= 1.0.0 (required — Node.js is NOT compatible). See [Setup Guide](setup-guide.md) for user-facing installation.
- Git
- A text editor with TypeScript support

## Getting Set Up
```bash
git clone https://github.com/mrosnerr/open-zk-kb
cd open-zk-kb
bun install
bun run build
bun test          # Verify everything works
```

## The Build Pipeline
- Source lives in src/, compiled output goes to dist/
- dist/ is what actually runs — the MCP server loads from dist/
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

## OpenCode local development

Use the normal installer for local OpenCode testing.

### Recommended workflow
```bash
bun run build
bun run setup install --client opencode --force
```

This configures OpenCode to run the local `dist/mcp-server.js` build through its MCP entry, registers the local checkout as a `file://` plugin, and refreshes the managed `AGENTS.md` block. That is the supported contributor workflow for testing changes on your development branch.

### What gets installed for OpenCode

- `mcp.open-zk-kb` points at your local `dist/mcp-server.js` build.
- `plugin` includes the local checkout as a `file://` plugin during source installs.
- `~/.config/opencode/AGENTS.md` gets the managed knowledge-base instructions.

### Navigation UX boundary

- Treat Obsidian as the human UX layer.
- Treat MCP + SQLite as the agent query layer.
- Keep core knowledge notes markdown-native.
- It is acceptable for generated `index` and `log` notes to adopt richer Obsidian-native functionality from the managed scaffold when that improves human navigation.
- Prefer Dataview for rendering index-page lists/tables where possible; keep the server focused on shell creation, storage, and guarantees.
- Prefer Obsidian plugins like Breadcrumbs for per-note navigation UI instead of injecting breadcrumb markdown into canonical note bodies.

> **How does the installer know to use local paths?** It checks whether the running script's parent directory contains a `.git` folder. If it does, you're running from a source checkout — the installer uses `file://` URLs and absolute paths. When installed via `bunx`/`npx` (no `.git`), it uses the `open-zk-kb` npm package name instead.

### Verify plugin changes locally

After rebuilding, rerun the installer and restart OpenCode so it reloads both the MCP server and plugin entry.

## Project Structure
(See [architecture.md](architecture.md) for details)

```
src/
├── mcp-server.ts       # MCP server entry point (stdio transport)
├── tool-handlers.ts    # Shared logic for all 8 tools
├── storage/
│   ├── NoteRepository.ts  # Core CRUD, FTS5, link tracking
│   ├── IndexBuilder.ts    # Auto-generates per-project index notes
│   └── LogAppender.ts     # Auto-appends to per-project log notes
├── config.ts           # Config loading (YAML with defaults)
├── schema.ts           # DB schema versioning + migrations
├── data-migrations.ts  # Agent-driven content upgrades
├── embeddings.ts       # Vector embedding support
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
- NEVER use console.log in server code — it breaks MCP stdio transport
- Exception: src/setup.ts and scripts/ are CLI tools where console output is fine

## Working on Obsidian UX

When improving Obsidian browsing:

1. Prefer enhancing generated `index` and `log` notes over changing canonical note bodies.
2. Keep plugin-specific markup out of core knowledge notes unless there is a strong indexing/story reason.
3. Remember that agents primarily query the MCP server and SQLite-backed repository, while humans consume the generated vault surfaces.

## Adding a New Tool
1. Add handler function in src/tool-handlers.ts
2. Register in src/mcp-server.ts (Zod schema + server.registerTool)
3. Add tests in tests/mcp-tools.test.ts
4. Rebuild: bun run build

See the [Tools Reference](tools-reference.md) for the current tool inventory and the [Configuration Reference](configuration.md) for config options.

## Adding a New Installer Client
1. Add entry to CLIENT_CONFIGS in src/setup.ts
2. Define: name, configPath, configFormat, mcpPath
3. Test: bun run setup install --client <name> --dry-run
