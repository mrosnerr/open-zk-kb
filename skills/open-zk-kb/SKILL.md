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
Use `knowledge-store` with **one concept per note**. Include `summary` (one-line takeaway) and `guidance` (imperative instruction for future agents). If you learn multiple things, make multiple store calls — don't bundle.

**Kinds** (with example notes and target word counts):
- **personalization** (~50 words) — "User prefers Bun over Node.js for all runtime tasks"
- **decision** (~150 words) — "Chose FTS5 over trigram search because..."
- **observation** (~100 words) — "Bun's globalThis.fetch includes `preconnect` — use `as any` cast"
- **reference** (~120 words) — "getStaleNotes filters on `created_at`, not `updated_at`"
- **procedure** (~150 words) — "Release: `bun run release` → bumps version, changelog, PR"
- **resource** (~50 words) — "Bun SQLite docs: https://bun.sh/docs/api/sqlite"

Notes exceeding the target will trigger a soft warning — heed it and split if the note covers more than one concept.

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
