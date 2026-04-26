# Note Kinds Reference

Detailed descriptions and examples for each knowledge base note kind.

## personalization
User preferences, habits, and working style. Default lifecycle: `living`.

**When to store**: User says "I prefer", "always", "never", or corrects your approach.

**Examples**:
- "User prefers Bun over Node.js for all runtime tasks"
- "Always use single quotes in TypeScript"
- "User works in Pacific timezone, prefers async communication"

## decision
Architecture choices, trade-off analyses, and rationale. Default lifecycle: `snapshot`.

**When to store**: You and the user weigh options and pick one. Decisions are immutable once stored — create a new decision note if the choice changes.

**Examples**:
- "Chose FTS5 over trigram search — better phrase matching, lower complexity"
- "Decided on SQLite over PostgreSQL — single-user, no server dependency"
- "Selected YAML for config over TOML — better multi-line string support"

## observation
Non-obvious errors, gotchas, and runtime behaviors worth remembering. Default lifecycle: `snapshot`.

**When to store**: You hit a surprising error or discover unexpected behavior.

**Examples**:
- "Bun's globalThis.fetch includes `preconnect` header — use `as any` cast"
- "FTS5 `rank` column conflicts with custom column names — use `bm25()`"
- "SQLite WAL mode required for concurrent read/write in Bun"

## reference
Facts about the codebase, APIs, or tools that you looked up and may need again. Default lifecycle: `living`.

**When to store**: You look something up twice in one session, or find a detail that's hard to rediscover.

**Examples**:
- "getStaleNotes filters on `created_at`, not `updated_at`"
- "NoteRepository uses TEXT primary key, not INTEGER — affects FTS5 trigger design"
- "SchemaManager migration runs on every `open()` call, not just first use"

## procedure
Multi-step workflows discovered by doing them. Default lifecycle: `living`.

**When to store**: You figure out a workflow with 3+ steps that would be useful to repeat. Procedures evolve — update freely as the workflow changes.

**Examples**:
- "Release: `bun run release` → bumps version, changelog, PR"
- "Add new tool: export handler in tool-handlers.ts, register in mcp-server.ts, add tests"
- "Debug MCP: set LOG_LEVEL=debug, check ~/.local/state/open-zk-kb/logs/"

## resource
Useful URLs, documentation links, and external references. Default lifecycle: `living`.

**When to store**: A useful URL comes up during work.

**Examples**:
- "Bun SQLite docs: https://bun.sh/docs/api/sqlite"
- "FTS5 tokenizer reference: https://sqlite.org/fts5.html#tokenizers"
- "MCP SDK repo: https://github.com/modelcontextprotocol/typescript-sdk"

## domain
Project operating manual — agent role, scope, conventions, and boundaries. Default lifecycle: `living`. Default status: `permanent`.

**When to store**: When a project needs a persistent operating manual that defines how the agent should work within it. One per project — enforced by the server.

**Constraints**:
- Requires a `project` parameter (rejected without one)
- One per project — storing a second domain note for the same project is rejected
- Always included in project-scoped search results (prepended before relevance-ranked results)

**Examples**:
- "conductor — Operating Manual: Agent role is operations assistant. Priority order: 1) monitoring 2) alerting 3) reporting..."
- "open-zk-kb — Operating Manual: Agent role is KB developer. Always use Bun, never Node.js..."

## index
Auto-generated project catalog. Default status: `permanent`. Default lifecycle: `living`.

**Created by**: The server automatically, on every project-scoped store, promote, or archive event. Agents cannot create index notes manually.

**Contents**: A catalog of all notes in the project, with wikilinks grouped by kind. Rebuilt from scratch on every event — always reflects the current state of the project.

**Constraints**:
- One per project — the server manages it, not agents
- Cannot be created via `knowledge-store`
- Use `knowledge-overview` to read it

## log
Auto-generated chronological operations log. Default status: `permanent`. Default lifecycle: `append-only`.

**Created by**: The server automatically, on every project-scoped store, promote, or archive event. Agents cannot create log notes manually.

**Contents**: A chronological list of events. Each entry has a bold date prefix (e.g., `**2026-04-26**: Stored "Prefer Bun over Node"`). Entries are appended — the log is never rewritten.

**Constraints**:
- One per project — the server manages it, not agents
- Cannot be created via `knowledge-store`
- Use `knowledge-overview` to read recent entries

## Lifecycle Reference

| Lifecycle | Behavior | When to use |
|-----------|----------|-------------|
| `living` | Mutable — updated freely | Evolving docs, preferences, procedures |
| `snapshot` | Immutable — server rejects updates | Point-in-time decisions, observations, dated analyses |
| `append-only` | Additive only — server rejects rewrites | Operations logs, decision histories (opt-in) |

Override via `lifecycle` parameter on `knowledge-store`. Titles containing dates (e.g., "2025-04-25") auto-default to `snapshot`.
