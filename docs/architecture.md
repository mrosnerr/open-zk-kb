# open-zk-kb Architecture

## System Overview

Persistent memory for agents, built on atomic linked notes. One knowledge base for all your tools — so context persists across sessions and clients. Implemented as a Model Context Protocol (MCP) server, any MCP-compatible client (OpenCode, Claude Code, Cursor, Windsurf, Zed) can interact with the same atomic, linked notes.

Knowledge capture is driven by the calling agent's instructions (e.g., a Claude Code skill, `AGENTS.md`, or global rules), which guide the model to use the `knowledge-store` tool when relevant information is encountered.

Obsidian plays a separate role: it is the primary human browsing and interaction layer for the vault. Agents mainly interact with the knowledge base through MCP tools backed by SQLite, not by navigating raw markdown files in Obsidian.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│                   Client Layer                       │
│  MCP Clients (OpenCode, Claude Code,                 │
│  Cursor, Windsurf, Zed, OMP, Pi)                     │
└──────────┬──────────────────────────────────────────┘
           │
      ┌────┴────┐
      │         │
┌─────▼─────┐ ┌─▼──────────────┐
│  stdio     │ │  HTTP (shared)  │
│  (default) │ │  Bun.serve()    │
└─────┬─────┘ └─┬──────────────┘
      │         │
      └────┬────┘
           │
┌──────────▼──────────┐
│   MCP Server        │
│   (mcp-server.ts)   │
│   - 9 MCP tools     │
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│   Tool Handlers     │
│   (tool-handlers.ts)│
│   handleStore()     │
│   handleSearch()    │
│   handleGet()       │
│   handleMaintain()  │
│   handleIngest()    │
│   handleOverview()  │
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
* **SQLite is the agent query layer**: A SQLite database provides fast metadata queries, bidirectional link tracking, and full-text search via the FTS5 extension. MCP tools primarily answer agent requests from this indexed layer plus server-rendered note content.
* **Rebuildability**: The database can be fully reconstructed from the Markdown files at any time using the `knowledge-maintain rebuild` tool.
* **Note IDs**: 16-digit timestamps (`YYYYMMDDHHmmss00`) with a 2-digit counter for same-second collisions ensure unique, chronologically sortable identifiers.
* **Manual FTS5 Management**: To ensure reliability with TEXT primary keys, the system manually manages the FTS5 index using `ftsInsert`, `ftsDelete`, and `ftsUpdate` methods rather than database triggers.

### Human vs Agent Surfaces

The vault has two distinct consumers:

* **Agents** query MCP tools such as `knowledge-search`, `knowledge-store`, and `knowledge-overview`. Their primary path is the SQLite-backed repository and server-owned rendering logic.
* **Humans** browse the vault in Obsidian using generated shell pages, activity logs, graph view, templates, scaffolded plugins, and Dataview-rendered sections.

This distinction is intentional. Core knowledge notes (`decision`, `procedure`, `reference`, `resource`, `observation`, `personalization`, `domain`) remain markdown-native and portable. Navigation notes (`index`, `log`) are allowed to carry richer Obsidian-specific UX because they are primarily human-facing surfaces. In the current design, the server creates and maintains the shell files, while Dataview increasingly owns the rendered lists and tables inside those shells.

**Rationale**: Markdown files are portable, human-readable, and git-friendly. SQLite provides the indexing required for efficient search and relationship tracking.

## MCP Server Architecture

The MCP server provides a reactive interface to the knowledge base:

* **Transport**: Supports two modes:
    * **Stdio** (default): One process per client connection. Used by all MCP clients.
    * **Streamable HTTP** (`open-zk-kb serve`): Single shared process for all clients. Uses `Bun.serve()` with `WebStandardStreamableHTTPServerTransport` in stateless mode. Recommended for multi-session environments (OMP, multiple terminals).
* **Shared Server Discovery**: When running in stdio mode, the server first checks if a shared HTTP server is available (via `$XDG_RUNTIME_DIR/open-zk-kb/server.json`). If found and healthy, it transparently bridges stdio→HTTP, avoiding resource duplication.
* **Resilience**: Bridges recover transparently from server crashes or restarts through an internal retry chain (retry → re-probe → process locally). See [Performance and Resilience](performance.md) for latency benchmarks, memory profiles, and failure mode analysis.
* **Tools**: Registers [nine core tools](tools-reference.md): `knowledge-store`, `knowledge-search`, `knowledge-get`, `knowledge-template`, `knowledge-mine`, `knowledge-maintain`, `knowledge-ingest`, `knowledge-overview`, and `knowledge-open`.
* **Initialization**: Uses a lazy singleton pattern where the `NoteRepository` is initialized only upon the first tool call.
* **Embeddings**: Generated locally by default via `@huggingface/transformers` (WASM backend, no native deps).
    * **Model**: `Xenova/all-MiniLM-L6-v2` (quantized q8, ~23MB).
    * **Cache**: Stored at `~/.cache/open-zk-kb/models/`.
    * **Override**: Supports optional vector embeddings via an OpenAI-compatible API if configured in `config.yaml`.

### Agent Instructions

During setup, open-zk-kb delivers knowledge base instructions to guide the AI to proactively search and store knowledge. The delivery mechanism varies by client:

* **Claude Code** uses a native [Claude Code skill](https://code.claude.com/docs/en/skills) installed to `~/.claude/skills/open-zk-kb/`. Claude auto-loads the instructions when it detects KB-related intent (preferences, decisions, lookups). The skill description is always in context (~80 tokens); full instructions load on-demand. See `installSkill()` in `src/setup.ts`.
* **OpenCode** uses an MCP entry in `~/.config/opencode/opencode.json` plus a managed markdown block injected into `~/.config/opencode/AGENTS.md`. The managed block is wrapped in comment-delimited markers (`<!-- OPEN-ZK-KB:START -->` / `<!-- OPEN-ZK-KB:END -->`). See `injectAgentDocs()` in `src/agent-docs.ts` and the OpenCode helpers in `src/setup.ts`.
* **Windsurf** uses a managed markdown block injected into `~/.codeium/windsurf/memories/global_rules.md`. Blocks are wrapped in comment-delimited markers (`<!-- OPEN-ZK-KB:START -->` / `<!-- OPEN-ZK-KB:END -->`). See `injectAgentDocs()` in `src/agent-docs.ts`.
* **Pi** does not support MCP natively. open-zk-kb ships as a Pi package extension (`src/pi/extension.ts`) that bridges the MCP server into Pi-native tools. Managed instructions are injected into `~/.pi/agent/AGENTS.md`.
* **OMP** uses standard MCP config at `~/.omp/agent/mcp.json`, a skill at `~/.omp/agent/skills/open-zk-kb/`, and a compact managed rule file at `~/.omp/agent/rules/open-zk-kb.md` (with YAML frontmatter for `alwaysApply`).
* **Cursor and Zed** currently receive MCP config only.
* **Instruction templates**: `templates/agent-instructions-full.md` (~420 tokens) and `templates/agent-instructions-compact.md` (~140 tokens) ship with the package for OpenCode/Windsurf/Pi/OMP. The skill uses its own `SKILL.md` + supporting files in `skills/open-zk-kb/`.

## Configuration Architecture

All settings live in a single YAML file: `~/.config/open-zk-kb/config.yaml`

- **Core settings**: vault, logLevel, lifecycle. Merged with hardcoded defaults from `src/config.ts`. See [Configuration Reference](configuration.md) for the full option list and [Note Lifecycle](note-lifecycle.md) for details on the review system.
- **Embeddings**: Top-level `embeddings:` section for configuring local or API-based vector generation.

## Schema & Migrations

The SQLite schema is versioned and managed programmatically:

* **Version Tracking**: Uses `PRAGMA user_version` (currently v6).
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
6. **Ownership Model ("Server Computes, Agent Judges")**: The server handles storage, indexing, computation, and validation. The calling agent handles all decisions about intent, relevance, and action. Behavioral guidance (skills, AGENTS.md instructions) bridges the gap by teaching the agent when and how to use server capabilities. See [#93](https://github.com/mrosnerr/open-zk-kb/issues/93) for the full policy.

## Ownership Boundaries

### MCP Server owns

* Canonical note storage and retrieval
* SQLite indexing, FTS5, embeddings, dedupe signals, lifecycle enforcement, and rebuilds
* Auto-generated structural notes such as `index` and `log`
* Deterministic shell generation for navigation artifacts

### Obsidian scaffold + plugins own

* Human browsing UX: dashboards, Breadcrumbs-plugin navigation, templates, buttons, calendar views, graph usage, and other plugin-powered interactions
* Dataview-rendered lists/tables and other presentation-layer enhancements for generated navigation files, especially `index` and `log`

See [Obsidian Guide](obsidian.md) for the full plugin list, navigation structure, and screenshots.

The current direction is to move breadcrumbs out of server-injected note bodies and into Obsidian-owned rendering via the Breadcrumbs plugin plus shell-file metadata on generated navigation pages.

Plugins should not become the source of truth for core knowledge. They decorate and accelerate the human experience on top of server-owned data.

### Agents own

* Deciding what knowledge matters
* Choosing when to search, store, promote, archive, or ingest
* Interpreting search results and deciding how to act on them

Agents should treat `index` and `log` as secondary orientation surfaces, not as the canonical storage format for knowledge.

### Documentation policy for Obsidian-specific markup

* **Allowed**: Dataview, Meta Bind, QuickAdd-driven affordances, and similar Obsidian-only UX in generated `index` and `log` files.
* **Preferred**: Core knowledge notes remain plain markdown with YAML frontmatter and Obsidian-compatible wikilinks.
* **Reason**: This keeps the agent-facing storage/indexing layer clean while giving humans a richer vault experience. Prefer Dataview for index-page list rendering when possible so the MCP server owns less presentation logic.

---
For implementation details, see [src/AGENTS.md](../src/AGENTS.md) and [tests/AGENTS.md](../tests/AGENTS.md).
