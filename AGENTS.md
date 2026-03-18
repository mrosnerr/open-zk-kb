# open-zk-kb — Agent Knowledge Base

## Overview

MCP server for persistent Zettelkasten knowledge management. TypeScript/Bun, SQLite FTS5, Markdown files with YAML frontmatter. Entry point: `mcp-server.ts` (MCP stdio).

## Structure

```
.
├── src/                   # Source (see src/AGENTS.md)
│   ├── mcp-server.ts      # MCP stdio server entry
│   ├── tool-handlers.ts   # Shared handler functions
│   ├── storage/            # NoteRepository — SQLite+FTS5+filesystem
│   └── utils/              # Path resolution, wikilink parsing
├── skills/                # Skill templates for Claude Code
│   └── open-zk-kb/        # Copied to ~/.claude/skills/open-zk-kb/ on install
│       ├── SKILL.md        # Main skill (frontmatter + instructions)
│       └── kinds-reference.md  # Supporting reference (loaded on-demand)
├── tests/                 # Test suite (see tests/AGENTS.md)
├── docs/                  # User-facing documentation
│   ├── architecture.md    # System design, dual storage, design decisions
│   ├── configuration.md   # Full config reference (single YAML file)
│   ├── note-lifecycle.md  # Note statuses, kinds, review system
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
| Add/modify a tool | `src/tool-handlers.ts` | Shared by MCP server |
| Register tool for MCP | `src/mcp-server.ts` | Uses @modelcontextprotocol/sdk |
| Storage/DB changes | `src/storage/NoteRepository.ts` | ~1,370 LOC, dual SQLite+filesystem |
| Schema migrations | `src/schema.ts` | PRAGMA user_version based |
| Data migrations | `src/data-migrations.ts` | Agent-driven content upgrades |
| Configuration | `src/config.ts` | YAML config with defaults |
| Types/interfaces | `src/types.ts` | NoteKind, NoteStatus, AppConfig |
| Note rendering | `src/prompts.ts` | XML format for agent consumption |
| Install/uninstall CLI | `src/setup.ts` | 5 clients: opencode, claude-code, cursor, windsurf, zed |
| Tests | `tests/` | bun:test with harness + fixtures |

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
| `AppConfig` | interface | `types.ts` | Config shape: vault, logLevel, lifecycle |
| `SchemaManager` | class | `schema.ts` | DB schema versioning (v5), migrations |
| `getConfig` | function | `config.ts` | 2-layer merge: defaults → YAML config |
| `logToFile` | function | `logger.ts` | File-based logging (XDG_STATE_HOME) |
| `renderNoteForAgent` | function | `prompts.ts` | XML note rendering for agent consumption |
| `renderNoteForSearch` | function | `prompts.ts` | XML note rendering with full content for search results |
| `injectAgentDocs` | function | `agent-docs.ts` | Injects KB instructions into client instruction files |
| `removeAgentDocs` | function | `agent-docs.ts` | Removes injected KB instructions on uninstall |
| `installSkill` | function | `setup.ts` | Copies skill files to `~/.claude/skills/open-zk-kb/` |
| `CLIENT_CONFIGS` | const | `setup.ts` | Maps client → config paths, MCP format, skill/agentDocs paths |

## Anti-Patterns (This Project)

1. **NEVER** use `console.log()`, `console.warn()`, `console.error()` in server code
   - **USE** `logToFile()` from `src/logger.ts` — MCP stdio requires clean stdout
   - Exception: `src/setup.ts` and `scripts/` CLI commands (user-facing output is OK)
2. **NEVER** skip rebuild after source changes — `dist/` is what actually runs
3. **NEVER** use FTS5 triggers — manually managed for TEXT primary key reliability
4. **NEVER** call `removeVault` without `confirm: true` — irreversible deletion

## Conventions

- **Factory pattern**: Classes export `createXxx()` factory (e.g., `createNoteRepository`)
- **Lazy singletons**: Repository initialized on first tool call, not at startup
- **Note IDs**: `YYYYMMDDHHmmss00` (16-digit: timestamp + 2-digit counter for same-second collisions)
- **Filenames**: `{id}-{slug}.md`
- **XDG paths**: vault=`$XDG_DATA_HOME/open-zk-kb`, config=`$XDG_CONFIG_HOME/open-zk-kb/config.yaml`, logs=`$XDG_STATE_HOME/open-zk-kb/logs/`
- **Single config file**: `~/.config/open-zk-kb/config.yaml` — top-level keys for core settings and `embeddings:`
- **Dual storage**: Filesystem is source of truth; DB is index. `rebuildFromFiles()` reconstructs DB from .md files
- **Shared handlers**: `tool-handlers.ts` exports pure functions — called by MCP server
- **ESM only**: `"type": "module"` — no CommonJS
- **Strict TS**: `strict: true`, ES2022 target, NodeNext resolution
- **Commit messages**: Capitalized imperative, no prefix, no trailing period (e.g. `Add feature`, `Fix bug`, `Update docs`)

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
- **Knowledge capture**: Claude Code uses skills (`~/.claude/skills/open-zk-kb/`); other clients use injected `AGENTS.md` instructions. Calling models use `knowledge-store` directly.
- **Claude Code skill**: Instructions delivered as a skill at `~/.claude/skills/open-zk-kb/`. Template files in `skills/open-zk-kb/`.
- **Local embeddings**: MiniLM-L6-v2 (~23MB) enabled by default via `@huggingface/transformers`. No API key required. Opt-in to API embeddings via `config.yaml`.
