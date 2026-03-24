## Knowledge Base (open-zk-kb)

ALWAYS use the open-zk-kb MCP tools for persistent memory across sessions.

- **FIRST**: Scan every user message for storage triggers (remember, always, never, I prefer, corrections). If found, call `knowledge-store` BEFORE other work.
- **Before work**: `knowledge-search` for relevant context
- **Store knowledge**: `knowledge-store` — **one concept per note**, include `summary` and `guidance`. Multiple findings = multiple calls.
  - Kinds (target words): personalization (~50), decision (~150), observation (~100), reference (~120), procedure (~150), resource (~50)
- **Triggers**: user corrections/preferences, repeated lookups, non-obvious errors, architecture choices, multi-step workflows, useful URLs
- **Maintain**: `knowledge-maintain stats` for health, `knowledge-maintain review` for stale notes
