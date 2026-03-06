# open-zk-kb Architecture

## System Overview

open-zk-kb is a knowledge management system with two entry points:

1. **MCP Server** (`src/mcp-server.ts`): Implements the standard Model Context Protocol (MCP) stdio transport. It allows any MCP-compatible client (Claude Code, Cursor, Windsurf, Zed) to interact with the knowledge base.
2. **OpenCode Plugin** (`src/opencode-plugin.ts`): An enhanced integration for OpenCode that provides active features like auto-capture, quality gate filtering, and multi-layer context injection.

Both entry points share a common storage layer and tool handlers, ensuring consistency across different client environments.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│                   Client Layer                       │
│  MCP Clients (Claude Code,     OpenCode              │
│  Cursor, Windsurf, Zed)        (with plugin hooks)   │
└──────────┬─────────────────────────┬────────────────┘
           │                         │
┌──────────▼──────────┐  ┌──────────▼──────────────┐
│   MCP Server        │  │   OpenCode Plugin        │
│   (mcp-server.ts)   │  │   (opencode-plugin.ts)   │
│   - 3 tool handlers │  │   - 6 hooks              │
│   - stdio transport  │  │   - Pattern detection    │
│                      │  │   - Quality gate (LLM)   │
│                      │  │   - Context injection    │
└──────────┬──────────┘  └──────────┬──────────────┘
           │                         │
           └────────────┬────────────┘
                        │
            ┌───────────▼───────────┐
            │   Tool Handlers       │
            │   (tool-handlers.ts)  │
            │   handleStore()       │
            │   handleSearch()      │
            │   handleMaintain()    │
            └───────────┬───────────┘
                        │
            ┌───────────▼───────────┐
            │   NoteRepository      │
            │   (NoteRepository.ts) │
            │   CRUD + FTS5 search  │
            │   Link tracking       │
            └──────┬──────┬─────────┘
                   │      │
          ┌────────▼┐  ┌──▼────────┐
          │ SQLite  │  │ Markdown  │
          │ + FTS5  │  │ Files     │
          │ (index) │  │ (source)  │
          └─────────┘  └───────────┘
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
* **Embeddings**: Supports optional vector embeddings if configured in `config.yaml` via an OpenAI-compatible API.
* **Behavior**: Purely reactive; it does not perform auto-capture or context injection.

## OpenCode Plugin Architecture

The OpenCode plugin provides proactive knowledge management through six lifecycle hooks:

* **Context Injection (2-layer)**:
    * **Layer 1 (`experimental.chat.system.transform`)**: Injects a balanced selection of top notes (baseline context). Results are cached with invalidation logic.
    * **Layer 2 (`experimental.chat.messages.transform`)**: Performs an FTS5 search based on the user's current query and injects relevant notes, deduped against Layer 1.
    * **Rendering**: Notes are rendered as XML `<note>` elements with a 150-character content preview.
* **Pattern Detection**: Uses domain-agnostic regex patterns to detect knowledge structures (decisions, procedures, causal reasoning, etc.) in user and agent messages.
* **Quality Gate**: All auto-captured candidates pass through an external LLM API (OpenRouter-compatible).
    * **Stateless**: Uses direct `fetch()` calls instead of session lifecycles to avoid race conditions.
    * **Fail-Closed**: Rejects captures if the API call fails or errors.
    * **Concurrency**: Serialized via a promise mutex to prevent duplicate captures from concurrent hooks.
* **Capture Hooks**:
    * `chat.message`: Detects patterns in agent responses and drains the pending capture queue.
    * `tool.execute.after`: Captures output from external tools (e.g., `webfetch`, `context7`).
* **Session Lifecycle** (`event` hook): Tracks `session.created`, `session.deleted`, and `session.compacted` events. Resets per-session state (gate budget, caches, pending queues) on new sessions.
* **Session Compaction** (`experimental.session.compacting`): Preserves knowledge base context when the session is compacted by re-injecting baseline notes into the compacted context.

## Configuration Architecture

All settings live in a single YAML file: `~/.config/open-zk-kb/config.yaml`

- **Top-level keys** (vault, logLevel, lifecycle): Core settings used by both entry points. Merged with hardcoded defaults from `src/config.ts`. See [Note Lifecycle](note-lifecycle.md) for details on the review system.
- **`opencode:` section**: OpenCode plugin features (auto-capture thresholds, embedding API, injection parameters). Read via `getOpenCodeConfig()` — returns `null` if the section is absent.

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
3. **Fail-Closed Quality Gate**: Prioritizes knowledge base integrity. It is better to miss a potential capture than to pollute the system with low-quality or erroneous notes.
4. **Promise Mutex**: Prevents race conditions when multiple hooks (e.g., `experimental.chat.messages.transform` and `tool.execute.after`) attempt to process captures simultaneously.
5. **2-Layer Injection**: Layer 1 provides a stable baseline of important knowledge, while Layer 2 provides high-precision relevance to the current task.
6. **Bun Runtime**: Chosen for its built-in SQLite support (eliminating native compilation issues) and high-performance test runner.
7. **Wiki-links**: Adopts the Obsidian-compatible `[[slug|display]]` format to ensure interoperability with popular personal knowledge management tools.

---
For implementation details, see [src/AGENTS.md](../src/AGENTS.md) and [tests/AGENTS.md](../tests/AGENTS.md).
