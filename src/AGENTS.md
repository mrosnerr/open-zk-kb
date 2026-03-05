# src/ — Source Code

## Overview

Dual-entry TypeScript source: MCP server (`mcp-server.ts`) + OpenCode plugin (`opencode-plugin.ts`), sharing handlers via `tool-handlers.ts`.

## Structure

```
src/
├── mcp-server.ts          # MCP stdio server — 3 tools via @modelcontextprotocol/sdk
├── opencode-plugin.ts     # OpenCode plugin — 6 hooks + LLM quality gate + context injection (~1,384 LOC)
├── tool-handlers.ts       # Shared: handleStore, handleSearch, handleMaintain (~403 LOC)
├── storage/
│   └── NoteRepository.ts  # Core CRUD + FTS5 + link tracking (~1,235 LOC)
├── utils/
│   ├── path.ts             # ~ expansion, XDG path resolution
│   └── wikilink.ts         # [[slug|display]] parsing, Obsidian-compatible
├── config.ts              # getConfig() + getOpenCodeConfig(): YAML config with defaults
├── data-migrations.ts     # Agent-driven content upgrades (summary/guidance)
├── logger.ts              # logToFile() — file-based, never stdout
├── prompts.ts             # renderNoteForAgent() — XML <note> format
├── schema.ts              # SchemaManager — PRAGMA user_version (v3)
├── setup.ts               # CLI install/uninstall for 5 clients (bun run setup)
└── types.ts               # NoteKind, NoteStatus, NoteMetadata, PluginConfig
```

## Data Flow

```
Client request → mcp-server.ts OR opencode-plugin.ts
                        ↓
               tool-handlers.ts (handleStore/Search/Maintain)
                        ↓
               NoteRepository.store/search/getStats/...
                   ↓              ↓
            SQLite+FTS5     Markdown files
          (.index/knowledge.db)  ({id}-{slug}.md)
```

## Where to Look

| Task | File | Key Function/Class |
|------|------|--------------------|
| Add a new tool | `tool-handlers.ts` + both entry points | Export handler, register in each |
| Change search behavior | `NoteRepository.ts` | `search()` — FTS5 query sanitization |
| Add DB column | `schema.ts` | Bump `SCHEMA_VERSION`, add migration |
| Change note format | `NoteRepository.ts` | `buildFrontmatter()`, `parseMarkdownFile()` |
| Change context injection | `opencode-plugin.ts` | `system.transform` + `messages.transform` hooks |
| Add installer client | `setup.ts` | `CLIENT_CONFIGS` map |
| Change config defaults | `config.ts` | `DEFAULT_CONFIG` object |

## Key Patterns

- **Tool registration differs by entry point**: MCP uses `server.registerTool` with Zod schemas; OpenCode plugin uses hook-based auto-capture + context injection
- **NoteRepository is a lazy singleton**: Created on first tool call via `getOrCreateRepo()` (MCP) or `getRepo()` (plugin)
- **FTS5 is manually managed**: `ftsInsert`/`ftsDelete`/`ftsUpdate` — no SQLite triggers
- **Query sanitization**: Strips FTS5 operators, limits to 10 terms, wraps in quotes, joins with OR
- **Frontmatter sync**: DB is authoritative; frontmatter updates are best-effort (non-fatal on failure)
- **Schema migrations**: DDL via `PRAGMA user_version`; data migrations via agent-driven `upgrade` action

## Anti-Patterns

1. **NEVER** import from `dist/` — always import from `src/` siblings
2. **NEVER** use `console.log` except in `setup.ts` and `scripts/` CLI commands
3. **NEVER** add FTS5 triggers — manual management is intentional
4. **NEVER** store note content in DB `content` column — it stores summary/excerpt only; full content is in .md files

## OpenCode Plugin Architecture

### Quality Gate (LLM-based capture filtering)

All auto-captures pass through an LLM quality gate before storage. No heuristic-only fallback exists.

- **External API**: Direct `fetch()` to OpenRouter-compatible endpoint — no session lifecycle, no cleanup
- **Config**: `~/.config/open-zk-kb/config.yaml` — `opencode.capture` section (base_url, api_key, model, max_calls_per_session)
- **Concurrency**: Promise-based mutex (`gateInFlight`) serializes all gate calls — prevents races between hooks
- **Budget**: `qualityGateSuccessCount` tracks only successful evaluations; failed/timed-out calls don't consume budget
- **Timeout**: 15s per gate call via `AbortController` — clean cancellation, no orphaned sessions
- **Failure mode**: Fail closed — on any API error or timeout, capture is rejected (returns null)

### Capture Paths (3 total, all require quality gate)

1. **User messages** (`messages.transform`): Pattern detection queues candidates into `pendingUserCaptures` (bounded at `MAX_PENDING_CAPTURES = 10`). Queue drains in `chat.message` hook (outside LLM pipeline to avoid deadlock).
2. **Agent messages** (`chat.message`): Pattern detection → direct gate call → store if approved.
3. **Tool outputs** (`tool.execute.after`): Only external reference tools (`webfetch`, `context7_*`, `ddg-search_*`) → gate call → store if approved.

### Context Injection (2-layer with dedup)

- **Layer 1** (`system.transform`): Baseline notes — cached in `baselineNotesCache`, only re-fetched when `baselineInvalidated` flag is set by captures.
- **Layer 2** (`messages.transform`): Query-relevant notes — filtered against `baselineNotesCache.noteIds` to prevent duplication.

### Key State Variables

| Variable | Purpose |
|----------|---------|
| `qualityGateSuccessCount` | Budget tracker (successful evaluations only) |
| `gateInFlight` | Promise-based mutex for serialization |
| `pendingUserCaptures` | Bounded queue for user message candidates |
| `baselineNotesCache` | Cached Layer 1 notes + IDs for dedup |
| `baselineInvalidated` | Flag set by captures to trigger cache refresh |