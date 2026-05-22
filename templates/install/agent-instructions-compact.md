## Knowledge Base (open-zk-kb)

ALWAYS use the open-zk-kb MCP tools for persistent memory across sessions.

Use open-zk-kb for concise cross-session agent memory. Put full project analysis in the project's existing knowledge location — docs, specs, ADRs, wikis, notes, or another convention. When both apply, store the agent-facing takeaway in the KB and the full project-facing artifact in project-local files.

- **FIRST**: Before every response: (1) `knowledge-search` for relevant context, (2) follow each note's `<guidance>` tag, (3) scan for storage triggers (remember, always, never, I prefer, corrections) and call `knowledge-store` BEFORE other work.
- **Store knowledge**: `knowledge-store` — **one concept per note**, include `summary` and `guidance`. Multiple findings = multiple calls. For structured kinds, `knowledge-template --kind {kind}` shows expected sections (e.g. decision: Context/Options/Decision/Tradeoffs/Consequences).
  - Kinds (key sections): personalization (~50w: Preference, Context, Examples, Source), decision (~150w: Context, Options Considered, Decision, Tradeoffs Accepted, Consequences, Reversibility), observation (~100w: What I Saw, Where, Why It Matters, Implications), reference (~120w: Key Excerpts, Original Content), procedure (~150w: Trigger, Prerequisites, Steps, Verification, Common Failure Modes, Changelog), resource (~50w: What It Is, Why It's Useful, Key References, Notes from Use), domain (~500w: Agent Role, Scope, Note Conventions, Operations Playbook, Boundaries, Glossary — one per project). Note: index and log are auto-generated — never create manually.
  - Lifecycle: `living` (default), `snapshot` (immutable — decisions, observations), `append-only`. Server enforces.
  - Staleness: `staleness_days` on every note — days since last access (or creation). If > 90 days, verify before relying.
- **Triggers**: user corrections/preferences, repeated lookups, non-obvious errors, architecture choices, multi-step workflows, useful URLs
- **Client scoping**: Client-specific paths (`.cursor/`, `.claude/`) auto-tagged on store. No action needed.
- **Ingest URLs**: `knowledge-ingest` to extract articles, then `knowledge-store` to save. Prefer passing HTML from your web tools.
- **Project overview**: `knowledge-overview(project: "...")` — computed inventory and recent log entries. Omit `project` for global overview.
- **Mine sessions**: `knowledge-mine(candidates: [...], dry_run: true)` — bulk-screen candidates from session history. Extract decisions, observations, procedures from past sessions via `session_list`/`session_read`, pass as candidates. STORE/SKIP/REVIEW classification. Call with `dry_run: false` to store.
- **Metrics**: `knowledge-stats` — health counts, embedding coverage, staleness, growth by kind. Params: `project?`, `period?`, `telemetry?`.
- **Maintain**: `knowledge-maintain(action: "full")` for one-command maintenance. Individual: `review` (stale notes), `dedupe`, `embed`, `migrate-layout`.
