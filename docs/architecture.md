# open-zk-kb Architecture

## System Overview

open-zk-kb is a persistent knowledge management system implemented as a Model Context Protocol (MCP) server. It allows any MCP-compatible client (OpenCode, Claude Code, Cursor, Windsurf) to interact with a Zettelkasten-style knowledge base.

Knowledge capture is driven by the calling agent's instructions (e.g., `AGENTS.md` or `CLAUDE.md`), which guide the model to use the `knowledge-store` tool when relevant information is encountered.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│                   Client Layer                       │
│  MCP Clients (OpenCode, Claude Code,                 │
│  Cursor, Windsurf)                                   │
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

### Instruction Injection

During setup, open-zk-kb automatically injects knowledge base instructions into each client's global instruction file. This guides the AI to proactively search and store knowledge without requiring manual configuration.

* **Canonical source**: Instructions ship with the npm package in two variants: `agent-instructions-full.md` (~420 tokens, detailed) and `agent-instructions-compact.md` (~140 tokens, minimal). Each client has a default size configured in `CLIENT_CONFIGS`; users can override with `--instructions compact|full`.
* **Managed markers**: Injected blocks are wrapped in comment-delimited markers (`<!-- OPEN-ZK-KB:START -->` and `<!-- OPEN-ZK-KB:END -->`), allowing safe upgrades and removal.
* **Lifecycle management**: The `injectAgentDocs()` function (in `src/agent-docs.ts`) handles installation; `removeAgentDocs()` handles uninstall. Re-running the installer updates only the content between markers, preserving user-added content outside the block.
* **Client-specific paths**: Each client has a dedicated instruction file (e.g., `~/.config/opencode/AGENTS.md` for OpenCode, `~/.claude/CLAUDE.md` for Claude Code, `~/.codeium/windsurf/memories/global_rules.md` for Windsurf).

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
