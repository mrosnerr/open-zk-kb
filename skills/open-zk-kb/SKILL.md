---
name: open-zk-kb
description: >
  Persistent knowledge base for cross-session memory. Search before starting
  work for relevant context, decisions, and preferences. Store new knowledge
  when the user corrects you, states preferences, makes architecture decisions,
  or when you discover non-obvious errors, workflows, or useful references.
  Run maintenance to review stale notes.
---

## Knowledge Base (open-zk-kb)

ALWAYS use the open-zk-kb MCP tools to maintain persistent memory across sessions.

### Before Work
- `knowledge-search` for relevant context (preferences, decisions, patterns)

### Storing Knowledge
Use `knowledge-store` with one concept per note. Include `summary` (one-line takeaway) and `guidance` (imperative instruction for future agents).

**Kinds** (with example notes):
- **personalization** — "User prefers Bun over Node.js for all runtime tasks"
- **decision** — "Chose FTS5 over trigram search because..."
- **observation** — "Bun's globalThis.fetch includes `preconnect` — use `as any` cast"
- **reference** — "getStaleNotes filters on `created_at`, not `updated_at`"
- **procedure** — "Release: `bun run release` → bumps version, changelog, PR"
- **resource** — "Bun SQLite docs: https://bun.sh/docs/api/sqlite"

### When to Store (immediately, not deferred)
- User corrects you or says "always/never/I prefer" → **personalization**
- You look something up twice in one session → **reference**
- You hit a non-obvious error or gotcha → **observation**
- You and user weigh options and pick one → **decision**
- You discover a multi-step workflow by doing it → **procedure**
- A useful URL comes up → **resource**

### Capture Checkpoints
- Every task plan with 3+ todos: add a final **"Capture learnings → knowledge base"** todo.
- At natural breakpoints (complex debug, architecture choice, topic change): ask *"Anything worth saving?"*
- Before ending a session: review for uncaptured preferences, decisions, gotchas, or workflows.

### Maintenance
- `knowledge-maintain stats` — KB health | `knowledge-maintain review` — stale notes

For detailed kind descriptions and examples, see [kinds-reference.md](kinds-reference.md).
