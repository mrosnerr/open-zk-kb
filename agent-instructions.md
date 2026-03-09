## Knowledge Base (open-zk-kb)

ALWAYS use the open-zk-kb MCP tools to maintain persistent memory across sessions.

### Before Starting Work
- Search for relevant context: preferences, past decisions, patterns
  - `knowledge-search` with a query describing what you're about to do
  - Check for personalization notes (user preferences, coding style)
  - Check for decision notes (past architectural choices)

### While Working
- Store valuable knowledge as you discover it:
  - **Decisions** with rationale → kind: decision
  - **User preferences** expressed or implied → kind: personalization
  - **Useful procedures** or workflows → kind: procedure
  - **Reference facts** worth remembering → kind: reference
  - **Tools, libraries, links** → kind: resource
  - **Patterns or insights** → kind: observation
- One concept per note. Be specific and actionable.
- Include a `summary` (one-line takeaway) and `guidance` (imperative instruction for future agents).

### Maintenance
- Use `knowledge-maintain stats` to check KB health
- Use `knowledge-maintain review` to surface stale notes for cleanup
