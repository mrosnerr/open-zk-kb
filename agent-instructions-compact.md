## Knowledge Base (open-zk-kb)

ALWAYS use the open-zk-kb MCP tools for persistent memory across sessions.

- **FIRST**: Before every response: (1) `knowledge-search` for relevant context (always pass `client: "{{CLIENT_NAME}}"`), (2) follow each note's `<guidance>` tag, (3) scan for storage triggers (remember, always, never, I prefer, corrections) and call `knowledge-store` BEFORE other work.
- **Store knowledge**: `knowledge-store` — **one concept per note**, include `summary` and `guidance`. Multiple findings = multiple calls.
  - Kinds (target words): personalization (~50), decision (~150), observation (~100), reference (~120), procedure (~150), resource (~50), domain (~500 — project operating manual, one per project). Note: index and log are auto-generated — never create manually.
  - Lifecycle: `living` (default), `snapshot` (immutable — decisions, observations), `append-only`. Server enforces.
  - Staleness: `staleness_days` on every note — days since last access (or creation). If > 90 days, verify before relying.
- **Triggers**: user corrections/preferences, repeated lookups, non-obvious errors, architecture choices, multi-step workflows, useful URLs
- **Client scoping**: Client-specific paths (`.cursor/`, `.claude/`) auto-tagged on store. No action needed.
- **Ingest URLs**: `knowledge-ingest` to extract articles, then `knowledge-store` to save. Prefer passing HTML from your web tools.
- **Project overview**: `knowledge-overview(project: "...")` — returns auto-generated index and recent log entries. Use at session start to orient in a project.
- **Maintain**: `knowledge-maintain stats` for health, `knowledge-maintain review` for stale notes
