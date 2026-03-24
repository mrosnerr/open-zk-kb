## Knowledge Base (open-zk-kb)

ALWAYS use the open-zk-kb MCP tools to maintain persistent memory across sessions.

### Pre-Flight: Before Responding to Any Message

ALWAYS do both of these **before any other work**:

1. **Search** — `knowledge-search` for relevant context (preferences, decisions, patterns) that may inform your response.
2. **Scan for storage triggers** — if the user's message matches a trigger below, call `knowledge-store` before proceeding with the task.

- User says "remember", "always", "never", "I prefer", "don't do X", or corrects you → **personalization**
- You and user weigh options and pick one → **decision**
- You hit a non-obvious error or gotcha → **observation**
- You look something up twice in one session → **reference**
- You discover a multi-step workflow by doing it → **procedure**
- A useful URL comes up → **resource**

NEVER defer storage to "after I finish the task." Store first, then work.

### Storing Knowledge
Use `knowledge-store` with **one concept per note**. Include `summary` (one-line takeaway) and `guidance` (imperative instruction for future agents). If you learn multiple things, make multiple store calls — don't bundle.

**Kinds** (with target word counts):
- **personalization** (~50 words) — "User prefers Bun over Node.js for all runtime tasks"
- **decision** (~150 words) — "Chose FTS5 over trigram search because..."
- **observation** (~100 words) — "Bun's globalThis.fetch includes `preconnect` — use `as any` cast"
- **reference** (~120 words) — "getStaleNotes filters on `created_at`, not `updated_at`"
- **procedure** (~150 words) — "Release: `bun run release` → bumps version, changelog, PR"
- **resource** (~50 words) — "Bun SQLite docs: https://bun.sh/docs/api/sqlite"

Notes exceeding the target will trigger a soft warning — heed it and split if the note covers more than one concept.

### Capture Checkpoints
- Every task plan with 3+ todos: add a final **"Capture learnings → knowledge base"** todo.
- At natural breakpoints (complex debug, architecture choice, topic change): ask *"Anything worth saving?"*
- Before ending a session: review for uncaptured preferences, decisions, gotchas, or workflows.

### Maintenance
- `knowledge-maintain stats` — KB health | `knowledge-maintain review` — stale notes
