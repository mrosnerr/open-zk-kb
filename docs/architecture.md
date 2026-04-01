# open-zk-kb Architecture

## System Overview

Shared, persistent memory for AI assistants, built on the Zettelkasten method. One knowledge base for all your tools — so context persists across sessions and clients. Implemented as a Model Context Protocol (MCP) server, any MCP-compatible client (OpenCode, Claude Code, Cursor, Windsurf, Zed) can interact with the same atomic, linked notes.

Knowledge capture is driven by the calling agent's instructions (e.g., a Claude Code skill, `AGENTS.md`, or global rules), which guide the model to use the `knowledge-store` tool when relevant information is encountered.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│                   Client Layer                       │
│  MCP Clients (OpenCode, Claude Code,                 │
│  Cursor, Windsurf, Zed)                              │
└──────────┬──────────────────────────────────────────┘
           │
┌──────────▼──────────┐
│   MCP Server        │
│   (mcp-server.ts)   │
│   - 3 tool handlers │
│   - stdio transport │
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│   Tool Handlers     │
│   (tool-handlers.ts)│
│   handleStore()     │
│   handleSearch()    │
│   handleMaintain()  │
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│   NoteRepository    │
│   (NoteRepository.ts)│
│   CRUD + FTS5 search│
│   Link tracking     │
└──────┬──────┬───────┘
       │      │
┌──────▼──┐┌──▼───────┐
│ SQLite  ││ Markdown  │
│ + FTS5  ││ Files     │
│ (index) ││ (source)  │
└─────────┘└───────────┘
```

## Dual Storage Model

The system employs a hybrid storage strategy to balance portability with performance:

* **Filesystem is source of truth**: Notes are stored as individual Markdown files with YAML frontmatter. Filenames follow the pattern `{id}-{slug}.md`.
* **SQLite is the index**: A SQLite database provides fast metadata queries, bidirectional link tracking, and full-text search via the FTS5 extension.
* **Rebuildability**: The database can be fully reconstructed from the Markdown files at any time using the `knowledge-maintain rebuild` tool.
* **Note IDs**: 16-digit timestamps (`YYYYMMDDHHmmss00`) with a 2-digit counter for same-second collisions ensure unique, chronologically sortable identifiers.
* **Manual FTS5 Management**: To ensure reliability with TEXT primary keys, the system manually manages the FTS5 index using `ftsInsert`, `ftsDelete`, and `ftsUpdate` methods rather than database triggers.

**Rationale**: Markdown files are portable, human-readable, and git-friendly. SQLite provides the indexing required for efficient search and relationship tracking.

## MCP Server Architecture

The MCP server provides a reactive interface to the knowledge base:

* **Transport**: Uses `@modelcontextprotocol/sdk` with stdio transport.
* **Tools**: Registers three core tools: `knowledge-store`, `knowledge-search`, and `knowledge-maintain`.
* **Initialization**: Uses a lazy singleton pattern where the `NoteRepository` is initialized only upon the first tool call.
* **Embeddings**: Generated locally by default via `@huggingface/transformers` (WASM backend, no native deps).
    * **Model**: `Xenova/all-MiniLM-L6-v2` (quantized q8, ~23MB).
    * **Cache**: Stored at `~/.cache/open-zk-kb/models/`.
    * **Override**: Supports optional vector embeddings via an OpenAI-compatible API if configured in `config.yaml`.

### Agent Instructions

During setup, open-zk-kb delivers knowledge base instructions to guide the AI to proactively search and store knowledge. The delivery mechanism varies by client:

* **Claude Code** uses a native [Claude Code skill](https://code.claude.com/docs/en/skills) installed to `~/.claude/skills/open-zk-kb/`. Claude auto-loads the instructions when it detects KB-related intent (preferences, decisions, lookups). The skill description is always in context (~80 tokens); full instructions load on-demand. See `installSkill()` in `src/setup.ts`.
* **OpenCode and Windsurf** use managed markdown blocks injected into their instruction files (`~/.config/opencode/AGENTS.md` and `~/.codeium/windsurf/memories/global_rules.md`). Blocks are wrapped in comment-delimited markers (`<!-- OPEN-ZK-KB:START -->` / `<!-- OPEN-ZK-KB:END -->`). See `injectAgentDocs()` in `src/agent-docs.ts`.
* **Cursor and Zed** currently receive MCP config only.
* **Instruction templates**: `agent-instructions-full.md` (~420 tokens) and `agent-instructions-compact.md` (~140 tokens) ship with the package for OpenCode/Windsurf. The skill uses its own `SKILL.md` + supporting files in `skills/open-zk-kb/`.

## Configuration Architecture

All settings live in a single YAML file: `~/.config/open-zk-kb/config.yaml`

- **Core settings**: vault, logLevel, lifecycle. Merged with hardcoded defaults from `src/config.ts`. See [Note Lifecycle](note-lifecycle.md) for details on the review system.
- **Embeddings**: Top-level `embeddings:` section for configuring local or API-based vector generation.

## Schema & Migrations

The SQLite schema is versioned and managed programmatically:

* **Version Tracking**: Uses `PRAGMA user_version` (currently v5).
* **DDL Migrations**: Managed by the `SchemaManager` class in `src/schema.ts`.
* **Data Migrations**: Handled in `src/data-migrations.ts` for agent-driven content upgrades.
* **Core Tables**:
    * `notes`: Primary metadata and content.
    * `notes_fts`: FTS5 virtual table for full-text search.
    * `note_links`: Tracks bidirectional wiki-links (`[[slug|display]]`).
    * `notes.embedding`: BLOB column storing vector representations for semantic search.

## Design Decisions

1. **Manual FTS5 Management**: SQLite FTS5 triggers can be unreliable with TEXT primary keys. Manual management provides deterministic control over index updates.
2. **Dual Storage**: Combines the longevity and portability of flat files with the query power of a relational database.
3. **Bun Runtime**: Chosen for its built-in SQLite support (eliminating native compilation issues) and high-performance test runner.
4. **Wiki-links**: Adopts the Obsidian-compatible `[[slug|display]]` format to ensure interoperability with popular personal knowledge management tools.
5. **Agent-Driven Capture**: Eliminates complex heuristic-based auto-capture in favor of explicit tool use by the calling model, guided by system instructions.

---
For implementation details, see [src/AGENTS.md](../src/AGENTS.md) and [tests/AGENTS.md](../tests/AGENTS.md).
