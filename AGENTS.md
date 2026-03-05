# open-zk-kb — Agent Knowledge Base

## Overview

MCP server + OpenCode plugin for persistent Zettelkasten knowledge management. TypeScript/Bun, SQLite FTS5, Markdown files with YAML frontmatter. Dual entry points: `mcp-server.ts` (MCP stdio) and `opencode-plugin.ts` (OpenCode plugin hooks).

## Structure

```
.
├── src/                   # Source (see src/AGENTS.md)
│   ├── mcp-server.ts      # MCP stdio server entry
│   ├── opencode-plugin.ts # OpenCode plugin entry (6 hooks + LLM quality gate)
│   ├── tool-handlers.ts   # Shared handler functions (both entries use)
│   ├── storage/            # NoteRepository — SQLite+FTS5+filesystem
│   └── utils/              # Path resolution, wikilink parsing
├── tests/                 # Test suite (see tests/AGENTS.md)
├── docs/                  # User-facing documentation
│   ├── architecture.md    # System design, dual storage, design decisions
│   ├── configuration.md   # Full config reference (single YAML file)
│   ├── development.md     # Local dev workflow, testing, debugging
│   └── setup-guide.md     # Step-by-step install for all clients
├── scripts/               # rebuild-db.ts
├── dist/                  # Compiled output (tsc) — this is what runs
├── config.example.yaml    # Template config (copy to ~/.config/open-zk-kb/config.yaml)
├── CONTRIBUTING.md        # Contributor guidelines
└── .gitignore             # Excludes dist/, node_modules/, config.yaml, etc.
```

## Where to Look

| Task | Location | Notes |
|------|----------|-------|
| Add/modify a tool | `src/tool-handlers.ts` | Shared by MCP + plugin |
| Register tool for MCP | `src/mcp-server.ts` | Uses @modelcontextprotocol/sdk |
| Register tool for OpenCode | `src/opencode-plugin.ts` | Plugin hooks + LLM quality gate (~1,384 LOC) |
| Storage/DB changes | `src/storage/NoteRepository.ts` | ~1,235 LOC, dual SQLite+filesystem |
| Schema migrations | `src/schema.ts` | PRAGMA user_version based |
| Data migrations | `src/data-migrations.ts` | Agent-driven content upgrades |
| Configuration | `src/config.ts` | YAML config with defaults |
| Types/interfaces | `src/types.ts` | NoteKind, NoteStatus, NoteMetadata |
| Note rendering | `src/prompts.ts` | XML format for agent consumption |
| Install/uninstall CLI | `src/setup.ts` | 5 clients: opencode, claude-code, cursor, windsurf, zed |
| Tests | `tests/` | bun:test with harness + fixtures |
| Plugin config | `~/.config/open-zk-kb/config.yaml` | `opencode:` section — capture, LLM gate, injection |

## Code Map

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `NoteRepository` | class | `storage/NoteRepository.ts` | Core CRUD, FTS5 indexing, link tracking |
| `handleStore` | function | `tool-handlers.ts` | knowledge-store implementation |
| `handleSearch` | function | `tool-handlers.ts` | knowledge-search implementation |
| `handleMaintain` | function | `tool-handlers.ts` | knowledge-maintain implementation |
| `NoteMetadata` | interface | `storage/NoteRepository.ts` | Domain model for notes |
| `NoteKind` | type | `types.ts` | 6 kinds: personalization, reference, decision, procedure, resource, observation |
| `NoteStatus` | type | `types.ts` | 3 statuses: fleeting → permanent → archived |
| `KIND_DEFAULT_STATUS` | const | `types.ts` | Maps kind → default status |
| `PluginConfig` | interface | `types.ts` | Config shape: vault, logLevel, grooming |
| `SchemaManager` | class | `schema.ts` | DB schema versioning (v3), migrations |
| `getConfig` | function | `config.ts` | 2-layer merge: defaults → YAML config |
| `logToFile` | function | `logger.ts` | File-based logging (XDG_STATE_HOME) |
| `renderNoteForAgent` | function | `prompts.ts` | XML note rendering for context injection |
| `renderNoteForSearch` | function | `prompts.ts` | XML note rendering with full content for search results |
| `getOpenCodeConfig` | function | `config.ts` | Returns `opencode:` section from config.yaml |

## Anti-Patterns (This Project)

1. **NEVER** use `console.log()`, `console.warn()`, `console.error()` in plugin/server code
   - **USE** `logToFile()` from `src/logger.ts` — MCP stdio requires clean stdout
   - Exception: `src/setup.ts` and `scripts/` CLI commands (user-facing output is OK)
2. **NEVER** skip rebuild after source changes — `dist/` is what actually runs
3. **NEVER** use FTS5 triggers — manually managed for TEXT primary key reliability
4. **NEVER** call `removeVault` without `confirm: true` — irreversible deletion

## Conventions

- **Factory pattern**: Classes export `createXxx()` factory (e.g., `createNoteRepository`)
- **Lazy singletons**: Repository initialized on first tool call, not at startup
- **Note IDs**: `YYYYMMDDHHmm` (12-digit timestamp) + collision counter
- **Filenames**: `{id}-{slug}.md`
- **XDG paths**: vault=`$XDG_DATA_HOME/open-zk-kb`, config=`$XDG_CONFIG_HOME/open-zk-kb/config.yaml`, logs=`$XDG_STATE_HOME/open-zk-kb/logs/`
- **Single config file**: `~/.config/open-zk-kb/config.yaml` — top-level keys for core settings, `opencode:` section for plugin features
- **Dual storage**: Filesystem is source of truth; DB is index. `rebuildFromFiles()` reconstructs DB from .md files
- **Shared handlers**: `tool-handlers.ts` exports pure functions — both MCP server and OpenCode plugin call these
- **ESM only**: `"type": "module"` — no CommonJS
- **Strict TS**: `strict: true`, ES2022 target, NodeNext resolution

## Commands

```bash
bun run build              # Compile TS → dist/ (REQUIRED after every change)
bun test                   # Run all tests
bun test --watch           # Watch mode
bun test --coverage        # Coverage report
bun run lint               # ESLint check
bun run lint:fix           # Auto-fix lint
rm -rf dist/ && bun run build  # Clean rebuild
EVAL=1 bun test tests/eval/eval.test.ts --timeout 120000  # Agent eval suite
```

## Notes

- **Bun runtime required** (>=1.0.0) — not Node.js compatible for tests/runtime
- **CI uses Bun** (`.github/workflows/ci.yml`)
- **Install via CLI**: `bun run setup install --client <name>` — single mechanism via `src/setup.ts`
- **Wiki-links**: Obsidian-compatible `[[slug|display]]` format with backlink tracking in `note_links` table
- **LLM quality gate**: All auto-captures pass through external LLM API (OpenRouter-compatible). Direct `fetch()` calls — no session lifecycle. Config: `config.yaml` `opencode.capture` section (base_url, api_key, model). Fails closed on API errors.
