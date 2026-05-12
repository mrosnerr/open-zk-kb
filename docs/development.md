# Development Guide

Everything you need to contribute to open-zk-kb or run it from source.

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

## Development Setup

Two paths depending on whether you're editing source code or just testing unreleased changes.

### Path 1: Source checkout (contributor workflow)

For making and testing code changes locally.

```bash
git clone https://github.com/mrosnerr/open-zk-kb
cd open-zk-kb
bun install
bun run build
bun run setup install --client <name> --force
```

Replace `<name>` with your client: `opencode`, `claude-code`, `cursor`, `windsurf`, or `zed`.

The installer auto-detects the source checkout (via `.git` presence) and wires everything to local paths:
- **MCP server** → your local `dist/mcp-server.js`
- **Plugin** (OpenCode) → `file://` URL pointing at your checkout
- **Agent instructions** → managed block in your client's instruction file

After every source change:
```bash
bun run build
bun run setup install --client <name> --force   # re-registers updated paths
# Restart your client so it reloads the MCP server and plugin
```

### Path 2: Dev channel (testing unreleased changes)

For testing the latest `dev` branch without cloning the repo.

```bash
bunx open-zk-kb@dev install --client <name> --force
```

That's it. The installer detects it's running from a dev release and writes `@dev` to your MCP config automatically. Each push to the `dev` branch publishes a new version (format: `X.Y.Z-dev.g<sha>`).

To switch back to stable:
```bash
bunx open-zk-kb@latest install --client <name> --force
```

See [Release Channels](setup-guide.md#release-channels) for more details.

### Navigation UX boundary

- Treat Obsidian as the human UX layer; MCP + SQLite as the agent query layer.
- Keep core knowledge notes markdown-native.
- Generated `index` and `log` notes may adopt richer Obsidian-native functionality when it improves human navigation.
- Prefer Dataview for rendering index-page lists/tables; keep the server focused on storage and guarantees.
- Prefer the Breadcrumbs plugin for per-note navigation instead of injecting breadcrumb markdown into note bodies.

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
