# open-zk-kb — Agent Knowledge Base

## Overview

Persistent memory for agents. One knowledge base for all your tools — so context persists across sessions and clients. TypeScript/Bun, SQLite FTS5, Markdown files with YAML frontmatter. Entry point: `mcp-server.ts` (MCP stdio). See [BRAND.md](./BRAND.md) for public voice and positioning.

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

## Testing

> Six-areas template per <https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/>

- **Framework**: `bun:test` with custom harness (`tests/harness.ts`) and fixtures
- **Run all**: `bun test`; pre-commit also runs `bun run typecheck`
- **Coverage**: `bun test --coverage`
- **Eval suite**: `EVAL=1 bun test tests/eval/eval.test.ts --timeout 120000` (agent-quality regression tests)
- **CI**: `.github/workflows/ci.yml` runs Bun build + lint + test + coverage on every PR
- **Conventions**: tests use `createTestHarness()` / `cleanupTestHarness()`; never use `.skip` without justification; mock OS-level interactions, never real side effects

## Structure

```
.
├── src/                   # Source (see src/AGENTS.md)
│   ├── mcp-server.ts      # MCP stdio server entry
│   ├── tool-handlers.ts   # Shared handler functions
│   ├── storage/            # NoteRepository — SQLite+FTS5+filesystem
│   │   ├── IndexBuilder.ts # Auto-generates per-project index notes
│   │   └── LogAppender.ts  # Auto-appends to per-project log notes
│   ├── obsidian.ts         # Obsidian detection, vault registry, launch
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
| Types/interfaces | `src/types.ts` | NoteKind, NoteStatus, Lifecycle, AppConfig |
| Note rendering | `src/prompts.ts` | XML format for agent consumption |
| Install/uninstall CLI | `src/setup.ts` | 7 clients: opencode, claude-code, cursor, windsurf, zed, pi, omp |
| Tests | `tests/` | bun:test with harness + fixtures |

## Code Map

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `NoteRepository` | class | `storage/NoteRepository.ts` | Core CRUD, FTS5 indexing, link tracking |
| `handleStore` | function | `tool-handlers.ts` | knowledge-store implementation |
| `handleSearch` | function | `tool-handlers.ts` | knowledge-search implementation |
| `handleMaintain` | function | `tool-handlers.ts` | knowledge-maintain implementation |
| `handleIngest` | function | `tool-handlers.ts` | knowledge-ingest implementation |
| `handleOverview` | function | `tool-handlers.ts` | knowledge-overview implementation |
| `handleMine` | function | `tool-handlers.ts` | knowledge-mine implementation |
| `handleOpen` | function | `tool-handlers.ts` | knowledge-open implementation |
| `handleStats` | function | `tool-handlers.ts` | knowledge-stats implementation |
| `detectObsidian` | function | `obsidian.ts` | Platform-specific Obsidian installation detection |
| `launchObsidian` | function | `obsidian.ts` | URI scheme or binary spawn to open vault |
| `NoteMetadata` | interface | `storage/NoteRepository.ts` | Domain model for notes |
| `NoteKind` | type | `types.ts` | 9 kinds: personalization, reference, decision, procedure, resource, observation, domain, index, log |
| `NavigationConfig` | interface | `types.ts` | Config shape for navigation: enableProjectIndex, enableProjectLog, overviewLogEntryLimit |
| `IndexBuilder` | class | `storage/IndexBuilder.ts` | Auto-generates per-project index notes with wikilinks grouped by kind |
| `LogAppender` | class | `storage/LogAppender.ts` | Auto-appends chronological event entries to per-project log notes |
| `NoteStatus` | type | `types.ts` | 3 statuses: fleeting → permanent → archived |
| `Lifecycle` | type | `types.ts` | 3 lifecycles: living, snapshot, append-only |
| `KIND_DEFAULT_STATUS` | const | `types.ts` | Maps kind → default status |
| `KIND_DEFAULT_LIFECYCLE` | const | `types.ts` | Maps kind → default lifecycle |
| `AppConfig` | interface | `types.ts` | Config shape: vault, logLevel, lifecycle, lifecycleDefaults, navigation |
| `SchemaManager` | class | `schema.ts` | DB schema versioning (v8), migrations |
| `LifecycleViolationError` | class | `storage/NoteRepository.ts` | Thrown on snapshot update or append-only rewrite |
| `getConfig` | function | `config.ts` | 2-layer merge: defaults → YAML config |
| `logToFile` | function | `logger.ts` | File-based logging (XDG_STATE_HOME) |
| `renderNoteForAgent` | function | `prompts.ts` | XML note rendering for agent consumption |
| `renderNoteForSearch` | function | `prompts.ts` | XML note rendering with full content for search results |
| `injectAgentDocs` | function | `agent-docs.ts` | Injects KB instructions into client instruction files |
| `removeAgentDocs` | function | `agent-docs.ts` | Removes injected KB instructions on uninstall |
| `installSkill` | function | `setup.ts` | Copies skill files to `~/.claude/skills/open-zk-kb/` |
| `CLIENT_CONFIGS` | const | `setup.ts` | Maps client → config paths, MCP format, skill/agentDocs paths |
| `installTtsrRule` | function | `setup.ts` | Installs OMP TTSR (Time-Traveling Stream Rules) enforcement rule |
| `removeTtsrRule` | function | `setup.ts` | Removes installed TTSR enforcement rule |

## Ownership Model

> **Server computes, agent judges.** The MCP server owns anything computable from data it already has. The agent owns anything requiring judgment, intent, or task context. Behavioral guidance (skills, AGENTS.md) bridges the gap. Full policy: [#93](https://github.com/mrosnerr/open-zk-kb/issues/93).

### Layer Responsibilities

| Layer | Owns | Examples |
|-------|------|----------|
| **Server** | Storage, indexing, computation, validation, structural note generation | CRUD, FTS5, embeddings, lifecycle enforcement, dedup detection, `index`/`log` generation |
| **Plugin / Obsidian Scaffold** | Human-facing presentation and interaction | Templates, dashboards, buttons, breadcrumbs, QuickAdd flows, Dataview/Meta Bind UX |
| **Behavioral Guidance** | When to call, how to interpret, quality standards | Storage triggers, kind selection, response interpretation |
| **Agent** | All decisions about intent, relevance, content | What to store, which suggestions to act on, link creation |

### Boundaries

- ✅ **Always**: Surface computed data in tool responses (similarity scores, dedup warnings, staleness metrics). Return data with annotations, not directives. Let the agent decide what to act on.
- ⚠️ **Ask first**: Adding server-side automation that fires without explicit agent request. Behavioral guidance is advisory ("a request, not a guarantee") — deterministic enforcement requires hooks/plugins.
- 🚫 **Never**: Auto-modify stored content beyond what the caller requested. Return directives ("you should X") in tool responses. Add skill instructions asking agents to replicate server computation. Gate tool behavior on missing optional parameters.

### Decision Framework

For any new feature, ask in order:
1. Computable from existing DB data? → **Server** owns it (surface in response)
2. Requires understanding intent or context? → **Agent** owns it (skill guides when/how)
3. Requires runtime state MCP can't access? → **Plugin** owns it (calls MCP tools)
4. Guides agent behavior across sessions? → **Behavioral guidance** owns it

### Obsidian UX boundary

- `index` and `log` are generated navigation surfaces for humans using Obsidian.
- Core knowledge notes (`decision`, `procedure`, `reference`, `resource`, `observation`, `personalization`, `domain`) stay markdown-native.
- Dataview, Meta Bind, QuickAdd-oriented affordances, and similar Obsidian-only UX should live in generated navigation files, not canonical knowledge notes.


### Documentation Structure

All project documentation lives in `docs/`. Only `index.md` and `log.md` belong in the docs root — everything else goes in a numbered subdirectory.

| Directory | Contents | Convention |
|---|---|---|
| `01-principles/` | Core principles, policies | Living docs |
| `02-patterns/` | Architecture, guides, practices | Living docs |
| `03-sources/` | Raw materials, imports, links | Reference |
| `04-references/` | Glossary, summaries | Mixed |
| `05-research/` | Research findings | Dated snapshots, immutable |
| `06-decisions/` | ADRs | Dated snapshots, immutable |
| `07-specs/` | PRDs, design specs | Mixed |

See `docs/index.md` for the full "Where Things Go" table.

---

## Boundaries

> Three-tier format follows: <https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/>

### ✅ Always
- Run `bun run build` after every source change — `dist/` is what actually runs
- Run `bun test` and `bun run typecheck` before committing
- Use `logToFile()` from `src/logger.ts` for any logging in server code (`src/`)
- Use parameterized SQL queries (handle `SQLITE_BUSY` with retries)
- Surface computed data with annotations (similarity, dedup, staleness) — server returns data, agent decides

### ⚠️ Ask first
- Schema migrations (PRAGMA `user_version`-based; see `src/schema.ts`)
- Adding new MCP capability advertisements (server capability negotiation)
- Adding dependencies to `package.json`
- Renaming top-level directories or changing the dual-storage layout

### 🚫 Never
- Use `console.log()`, `console.warn()`, `console.error()` in `src/` — MCP stdio requires clean stdout. Use `logToFile()`. (Exception: `src/setup.ts` and `scripts/` CLI commands.)
- Skip the rebuild after source changes — `dist/` is what actually runs
- Use FTS5 triggers — manually managed for TEXT primary key reliability
- Call `removeVault` without `confirm: true` — irreversible deletion
- Auto-modify stored content beyond what the caller explicitly requested — server surfaces data, agent decides actions
- Return directives in tool responses ("you should X") — return data with annotations, let the agent judge ([#93 violations](https://github.com/mrosnerr/open-zk-kb/issues/93))
- Add skill instructions that ask the agent to compute what the server already computes
- Commit secrets (`.env`, credentials, API keys, tokens)
- Suppress TypeScript errors with `as any`, `@ts-ignore`, `@ts-expect-error`

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
- **Server surfaces, agent acts**: Every computed insight (similarity, dedup, staleness) appears in the tool response. The agent decides what to do with it.
- **Hints, not directives**: Server responses include computed metrics (word count, similarity score, staleness days). Never phrased as recommendations.
- **Behavioral guidance is advisory**: Instructions are "a request, not a guarantee" ([Anthropic](https://docs.anthropic.com/en/docs/claude-code/features-overview)). Deterministic enforcement requires hooks/plugins.
- **Telemetry is local-only and opt-in**: Tool invocation counters are disabled by default; set `telemetry.enabled: true` to enable. Counters stay in SQLite, never include content or query strings. When disabled, both counter rows and access timestamp updates are skipped.

## Notes

- **Bun runtime required** (>=1.0.0) — not Node.js compatible for tests/runtime
- **CI uses Bun** (`.github/workflows/ci.yml`)
- **Install via CLI**: `bun run setup install --client <name>` — single mechanism via `src/setup.ts`
- **Wiki-links**: Obsidian-compatible `[[slug|display]]` format with backlink tracking in `note_links` table
- **Knowledge capture**: Claude Code and OMP use skills; OpenCode, Windsurf, and Pi use injected managed blocks (`AGENTS.md` or `rules/`). Calling models use `knowledge-store` directly.
- **Claude Code skill**: Instructions delivered as a skill at `~/.claude/skills/open-zk-kb/`. Template files in `skills/open-zk-kb/`.
- **Local embeddings**: MiniLM-L6-v2 (~23MB) enabled by default via `@huggingface/transformers`. No API key required. Opt-in to API embeddings via `config.yaml`.
- **10 MCP tools**: knowledge-store, knowledge-search, knowledge-get, knowledge-template, knowledge-mine, knowledge-stats, knowledge-maintain, knowledge-ingest, knowledge-overview, knowledge-open
- **Auto-generated notes**: `index` (per-project catalog, wikilinks grouped by kind) and `log` (per-project append-only event log) are auto-generated on project-scoped events. Agents cannot create them manually.
- **Human vs agent surfaces**: Obsidian is the primary human browsing layer; agents primarily use MCP tools backed by SQLite/indexed metadata rather than navigating raw vault files.
