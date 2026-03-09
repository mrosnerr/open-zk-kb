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
* **Note IDs**: 12-digit timestamps (`YYYYMMDDHHmm`) with a collision counter ensure unique, chronologically sortable identifiers.
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

## Configuration Architecture

All settings live in a single YAML file: `~/.config/open-zk-kb/config.yaml`

- **Core settings**: vault, logLevel, lifecycle. Merged with hardcoded defaults from `src/config.ts`. See [Note Lifecycle](note-lifecycle.md) for details on the review system.
- **Embeddings**: Top-level `embeddings:` section for configuring local or API-based vector generation.

## Schema & Migrations

The SQLite schema is versioned and managed programmatically:

* **Version Tracking**: Uses `PRAGMA user_version` (currently v3).
* **DDL Migrations**: Managed by the `SchemaManager` class in `src/schema.ts`.
* **Data Migrations**: Handled in `src/data-migrations.ts` for agent-driven content upgrades.
* **Core Tables**:
    * `notes`: Primary metadata and content.
    * `notes_fts`: FTS5 virtual table for full-text search.
    * `note_links`: Tracks bidirectional wiki-links (`[[slug|display]]`).
    * `note_embeddings`: Stores vector representations for semantic search.

## Design Decisions

1. **Manual FTS5 Management**: SQLite FTS5 triggers can be unreliable with TEXT primary keys. Manual management provides deterministic control over index updates.
2. **Dual Storage**: Combines the longevity and portability of flat files with the query power of a relational database.
3. **Bun Runtime**: Chosen for its built-in SQLite support (eliminating native compilation issues) and high-performance test runner.
4. **Wiki-links**: Adopts the Obsidian-compatible `[[slug|display]]` format to ensure interoperability with popular personal knowledge management tools.
5. **Agent-Driven Capture**: Eliminates complex heuristic-based auto-capture in favor of explicit tool use by the calling model, guided by system instructions.

---
For implementation details, see [src/AGENTS.md](../src/AGENTS.md) and [tests/AGENTS.md](../tests/AGENTS.md).

---
For implementation details, see [src/AGENTS.md](../src/AGENTS.md) and [tests/AGENTS.md](../tests/AGENTS.md).
