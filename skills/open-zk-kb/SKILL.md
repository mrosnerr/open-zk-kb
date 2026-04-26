---
name: open-zk-kb
version: 1.0.12
description: >
  Persistent knowledge base for cross-session memory. BEFORE responding to any
  user message: (1) knowledge-search for relevant context, (2) scan for storage
  triggers (remember, always, never, I prefer, corrections) and call
  knowledge-store FIRST. Then proceed with the task.
---

## Knowledge Base (open-zk-kb)

### Pre-Flight
ALWAYS do all of these **before any other work**:

1. **Search** — `knowledge-search` with `client: "claude-code"`. Use `kind`/`project`/`tags` filters to narrow. Try broader keywords if no results.
2. **Apply results** — follow each note's `<guidance>` tag. Personalization shapes style, decisions are binding, procedures are step-by-step, observations are verified gotchas.
3. **Scan for triggers** — if the user's message matches a trigger below, call `knowledge-store` before proceeding.

| Trigger | Kind |
|---------|------|
| User says "remember", "always", "never", "I prefer", "don't do X", or corrects you | **personalization** |
| You and user weigh options and pick one | **decision** |
| You hit a non-obvious error or gotcha | **observation** |
| You look something up twice in one session | **reference** |
| You discover a multi-step workflow by doing it | **procedure** |
| A useful URL comes up | **resource** |

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

Notes exceeding the target trigger a soft warning — split if the note covers more than one concept. Client-specific paths (e.g., `.cursor/`, `.claude/`) are auto-tagged; no need to pass `client` on store.

### Good vs Bad Examples
✅ **Good** — specific title, correct kind, actionable guidance:
```
title: "Bun SQLite requires explicit WAL mode for concurrent access"
kind: "observation"
summary: "SQLite in Bun uses journal mode by default; WAL must be set explicitly."
guidance: "Run `db.exec('PRAGMA journal_mode=WAL')` after opening any Bun SQLite db."
```

🚫 **Bad** — vague title, wrong kind, useless guidance:
```
title: "Database stuff"
kind: "reference"
summary: "Some notes about the database."
guidance: "Check the database."
```

### Kind Selection Guide
| Scenario | Kind |
|----------|------|
| User says they prefer tabs over spaces | **personalization** |
| We chose PostgreSQL over MySQL after comparing replication | **decision** |
| Bun's SQLite requires explicit WAL mode for concurrent access | **observation** |
| API endpoint for user creation is `POST /api/v2/users` | **reference** |
| Deploy: run build, tag version, push to registry | **procedure** |
| Bun SQLite docs: https://bun.sh/docs/api/sqlite | **resource** |

### Boundaries
✅ **Always**:
- One concept per note — split if in doubt
- Include both `summary` and `guidance` on every store call
- Search before storing to avoid duplicates
- Pass `client: "claude-code"` on search calls

⚠️ **Ask first**:
- Before archiving or deleting notes you didn't create this session
- Before changing the `kind` or `status` of a permanent note

🚫 **Never**:
- Bundle multiple concepts into one note
- Use vague titles like "Notes" or "Stuff"
- Store sensitive data (API keys, credentials, tokens)
- Defer storage to after task completion

### Lifecycle
Notes have a `lifecycle` field controlling mutability. The server enforces it.

| Lifecycle | Behavior | Default for |
|-----------|----------|-------------|
| `living` | Mutable, updated freely | personalization, reference, procedure, resource |
| `snapshot` | Immutable after creation | decision, observation |
| `append-only` | Additive only, no rewrites | (explicit opt-in) |

- **Auto-detection**: titles with a date (e.g., "Analysis 2026-04-26") auto-set to `snapshot`.
- **Enforcement**: snapshot updates and append-only rewrites are rejected by the server. Create a new note instead.
- **Migration**: notes without `lifecycle` default to `living`. No action needed; the field is added on next update.

**Server vs agent**: The server surfaces data and enforces constraints (lifecycle immutability, atomicity warnings, duplicate detection). You decide whether and how to act on surfaced information.

### Capture Checkpoints
- 3+ todo tasks: add a final **"Capture learnings → knowledge base"** todo.
- Natural breakpoints (debug, architecture choice, topic change): ask *"Anything worth saving?"*
- Session end: review for uncaptured preferences, decisions, gotchas, or workflows.

### Ingesting URLs
When a useful URL comes up: `knowledge-ingest` to extract, then `knowledge-store(kind: "resource", ...)`.

- **With a web tool** (Playwright, Exa, web_fetch): fetch first, then `knowledge-ingest(html: "...", url: "...")` — handles JS rendering and bot protection.
- **Without a web tool**: `knowledge-ingest(url: "...")` directly — basic fetch, may fail on protected sites.

### Maintenance
- `knowledge-maintain stats` — KB health | `knowledge-maintain review` — stale notes

For detailed kind descriptions and examples, see [kinds-reference.md](kinds-reference.md).
