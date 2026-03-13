# Contributing to open-zk-kb

Thank you for your interest in contributing to open-zk-kb. This project is an MCP server for persistent Zettelkasten knowledge management.

## Prerequisites

- Bun >= 1.0.0 (This project does not work with Node.js. Bun is required for runtime and tests.)
- Git

## Getting Started

```bash
git clone https://github.com/mrosnerr/open-zk-kb
cd open-zk-kb
bun install
bun run build    # Required — dist/ is what actually runs
bun test         # Verify everything works
```

## Development Workflow

- All source code is in `src/`, compiled to `dist/` via TypeScript.
- `dist/` is what runs. You must rebuild after every source change: `bun run build`.
- For iterative development: edit `src/` -> `bun run build` -> `bun test`.
- Clean rebuild: `rm -rf dist/ && bun run build`.

## Available Commands

| Command | Purpose |
|---------|---------|
| `bun run build` | Compile TypeScript to dist/ |
| `bun test` | Run all tests |
| `bun test --watch` | Watch mode |
| `bun test --coverage` | Coverage report |
| `bun run lint` | ESLint check |
| `bun run lint:fix` | Auto-fix lint issues |
| `EVAL=1 bun test tests/eval/eval.test.ts --timeout 120000` | Agent eval suite |

## Code Style & Conventions

- TypeScript strict mode (`strict: true`).
- ESM only (`"type": "module"`) — no CommonJS.
- ESLint with TypeScript plugin.
- Factory pattern: classes export `createXxx()` factories.
- Note IDs: `YYYYMMDDHHmmss00` (16-digit: timestamp + 2-digit counter for same-second collisions).
- XDG paths for data, config, and logs.

## Anti-Patterns (DO NOT)

- NEVER use `console.log()`, `console.warn()`, or `console.error()` in server code. MCP stdio requires clean stdout. Use `logToFile()` from `src/logger.ts`. Exception: `src/setup.ts` and `scripts/` (CLI output is OK).
- NEVER suppress type errors with `as any`, `@ts-ignore`, or `@ts-expect-error`.
- NEVER add FTS5 triggers. Manual FTS management is intentional.
- NEVER skip rebuild after source changes. `dist/` is what runs.
- NEVER call `removeVault` without `confirm: true`. This is an irreversible deletion.

## Project Structure

For more details, see `docs/architecture.md`.

```
src/
├── mcp-server.ts       # MCP stdio server entry
├── tool-handlers.ts    # Shared handler functions
├── storage/            # NoteRepository — SQLite + FTS5 + filesystem
├── config.ts           # Configuration loading
├── setup.ts            # CLI installer for 4 clients
└── types.ts            # TypeScript interfaces and types
```

## Testing Requirements

- All PRs must pass `bun test` and `bun run lint`.
- New features should include tests. See `tests/AGENTS.md` for testing patterns.
- Use `createTestHarness()` and `cleanupTestHarness()` from `tests/harness.ts`.
- Test handlers directly via imports from `tool-handlers.ts`.

## Branch Strategy

- **`dev`** — Active development. All PRs target `dev`.
- **`main`** — Stable/release branch. Merging `dev` → `main` auto-publishes to npm if the version in `package.json` was bumped.

## CI Pipeline

All PRs run: build, lint, unit tests, and **smoke tests** (install/uninstall for all 4 clients, MCP protocol verification, and a full KB round-trip).

You can run smoke tests locally:
```bash
bash tests/docker/smoke-test.sh
```

Or in a clean Docker container:
```bash
docker build -t open-zk-kb-smoke -f tests/docker/Dockerfile .
docker run --rm open-zk-kb-smoke bash tests/docker/smoke-test.sh
```

## Submitting Changes

1. Fork the repository.
2. Create a feature branch from `main`: `git checkout -b feature/my-feature main`.
3. Make your changes with tests.
4. Ensure `bun run build && bun test && bun run lint` all pass.
5. Commit with clear, descriptive messages (see [Commit Messages](#commit-messages)).
6. Open a Pull Request **targeting `dev`**. Your PR title becomes the commit message (squash merge), so it must follow the commit message convention.

## Commit Messages

Format: **Capitalized imperative sentence, no trailing period**

```
<Verb> <what changed>

Optional body explaining WHY, not just WHAT.
```

- **Capitalize** the first word: `Add feature` not `add feature`
- **Imperative mood**: `Add`, `Fix`, `Update`, `Remove`, `Expand` — not `Added`, `Fixes`, `Updates`
- **50 chars or less** for the subject line (hard limit: 72)
- **No trailing period** on the subject line
- **No conventional commit prefixes** (`feat:`, `fix:`, etc.) — plain English

Examples:
```
Add vector embeddings support for semantic search
Fix FTS5 query sanitization for special characters
Update manual install docs to use bunx from npm package
Remove deprecated migration path from schema v1
Expand Docker smoke tests from 21 to 97 checks
```

PRs use squash merge, so **your PR title becomes the commit message**. A CI check enforces the format on PR titles.

## Reporting Issues

- Use GitHub Issues.
- Include: steps to reproduce, expected behavior, and actual behavior.
- For bugs: include Bun version (`bun --version`) and OS.

## License

This project is licensed under the MIT License.
