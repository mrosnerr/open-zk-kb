# src/ — Source Code

## Overview

TypeScript source for the MCP server (`mcp-server.ts`), with core logic in `tool-handlers.ts` and `storage/`.

## Structure

```
src/
├── mcp-server.ts          # MCP stdio server — 8 tools via @modelcontextprotocol/sdk
├── tool-handlers.ts       # Shared: handleStore, handleSearch, handleTemplate, handleMine, handleMaintain, handleIngest, handleOverview, handleOpen
├── storage/
│   ├── NoteRepository.ts  # Core CRUD + FTS5 + link tracking (~1,370 LOC)
│   ├── IndexBuilder.ts    # Auto-generates per-project index notes
│   └── LogAppender.ts     # Auto-appends to per-project log notes
├── utils/
│   ├── path.ts             # ~ expansion, XDG path resolution
│   ├── wikilink.ts         # [[slug|display]] parsing, Obsidian-compatible
│   └── simhash.ts          # SimHash for near-duplicate detection
├── obsidian.ts            # Obsidian detection, vault registry, launch
├── config.ts              # getConfig(): YAML config with defaults
├── embeddings.ts          # Local + API embedding generation, similarity
├── data-migrations.ts     # Agent-driven content upgrades (summary/guidance)
├── logger.ts              # logToFile() — file-based, never stdout
├── prompts.ts             # renderNoteForAgent() — XML <note> format
├── schema.ts              # SchemaManager — PRAGMA user_version (v6)
├── setup.ts               # CLI install/uninstall for 7 clients (bun run setup)
└── types.ts               # NoteKind, NoteStatus, Lifecycle, AppConfig
```

## Data Flow

```
Client request → mcp-server.ts
                        ↓
               tool-handlers.ts (handleStore/Search/Mine/Maintain/Ingest/Overview/Open)
                        ↓
               NoteRepository.store/search/getStats/...
                    ↓              ↓
             SQLite+FTS5     Markdown files
           (.index/knowledge.db)  ({id}-{slug}.md)
```

## Where to Look

| Task | File | Key Function/Class |
|------|------|--------------------|
| Add a new tool | `tool-handlers.ts` + `mcp-server.ts` | Export handler, register in server |
| Change search behavior | `NoteRepository.ts` | `search()` — FTS5 query sanitization |
| Add DB column | `schema.ts` | Bump `SCHEMA_VERSION`, add migration |
| Change note format | `NoteRepository.ts` | `buildFrontmatter()`, `parseMarkdownFile()` |
| Add installer client | `setup.ts` | `CLIENT_CONFIGS` map |
| Change config defaults | `config.ts` | `DEFAULT_CONFIG` object |

## Key Patterns

- **Tool registration**: MCP uses `server.registerTool` with Zod schemas.
- **NoteRepository is a lazy singleton**: Created on first tool call via `getOrCreateRepo()`.
- **FTS5 is manually managed**: `ftsInsert`/`ftsDelete`/`ftsUpdate` — no SQLite triggers.
- **Query sanitization**: Strips FTS5 operators, limits to 10 terms, wraps in quotes, joins with OR.
- **Frontmatter sync**: DB is authoritative; frontmatter updates are best-effort (non-fatal on failure).
- **Schema migrations**: DDL via `PRAGMA user_version`; data migrations via agent-driven `upgrade` action.
- **Human vs agent surfaces**: SQLite + handlers serve agents; generated `index`/`log` notes plus the Obsidian scaffold serve humans.
- **Obsidian UX boundary**: Keep core knowledge notes markdown-native; richer Obsidian-specific UX belongs in generated navigation files.

## Anti-Patterns

1. **NEVER** import from `dist/` — always import from `src/` siblings
2. **NEVER** use `console.log` except in `setup.ts` and `scripts/` CLI commands
3. **NEVER** add FTS5 triggers — manual management is intentional
4. **NEVER** store note content in DB `content` column — it stores summary/excerpt only; full content is in .md files
