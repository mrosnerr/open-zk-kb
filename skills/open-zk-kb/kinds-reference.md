# Note Kinds Reference

Detailed descriptions and examples for each knowledge base note kind.

## personalization
User preferences, habits, and working style.

**When to store**: User says "I prefer", "always", "never", or corrects your approach.

**Examples**:
- "User prefers Bun over Node.js for all runtime tasks"
- "Always use single quotes in TypeScript"
- "User works in Pacific timezone, prefers async communication"

## decision
Architecture choices, trade-off analyses, and rationale.

**When to store**: You and the user weigh options and pick one.

**Examples**:
- "Chose FTS5 over trigram search — better phrase matching, lower complexity"
- "Decided on SQLite over PostgreSQL — single-user, no server dependency"
- "Selected YAML for config over TOML — better multi-line string support"

## observation
Non-obvious errors, gotchas, and runtime behaviors worth remembering.

**When to store**: You hit a surprising error or discover unexpected behavior.

**Examples**:
- "Bun's globalThis.fetch includes `preconnect` header — use `as any` cast"
- "FTS5 `rank` column conflicts with custom column names — use `bm25()`"
- "SQLite WAL mode required for concurrent read/write in Bun"

## reference
Facts about the codebase, APIs, or tools that you looked up and may need again.

**When to store**: You look something up twice in one session, or find a detail that's hard to rediscover.

**Examples**:
- "getStaleNotes filters on `created_at`, not `updated_at`"
- "NoteRepository uses TEXT primary key, not INTEGER — affects FTS5 trigger design"
- "SchemaManager migration runs on every `open()` call, not just first use"

## procedure
Multi-step workflows discovered by doing them.

**When to store**: You figure out a workflow with 3+ steps that would be useful to repeat.

**Examples**:
- "Release: `bun run release` → bumps version, changelog, PR"
- "Add new tool: export handler in tool-handlers.ts, register in mcp-server.ts, add tests"
- "Debug MCP: set LOG_LEVEL=debug, check ~/.local/state/open-zk-kb/logs/"

## resource
Useful URLs, documentation links, and external references.

**When to store**: A useful URL comes up during work.

**Examples**:
- "Bun SQLite docs: https://bun.sh/docs/api/sqlite"
- "FTS5 tokenizer reference: https://sqlite.org/fts5.html#tokenizers"
- "MCP SDK repo: https://github.com/modelcontextprotocol/typescript-sdk"
