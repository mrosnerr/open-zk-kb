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

#### What's worth capturing — examples by kind

- **personalization**: "User prefers Bun over Node.js for all runtime tasks" — captures an expressed or implied preference so future agents default correctly.
- **decision**: "Chose FTS5 over trigram search for full-text indexing because..." — records an architectural choice with rationale so it isn't revisited without cause.
- **observation**: "Bun's globalThis.fetch type includes a `preconnect` property that standard mocks lack — use `as any` cast" — a non-obvious gotcha discovered during work that will save future agents time.
- **reference**: "NoteRepository.getStaleNotes filters on `created_at`, not `updated_at`" — a factual detail about the codebase that's easy to get wrong.
- **procedure**: "To release: run `bun run release`, which bumps version, generates changelog, and creates a PR" — a reusable workflow with specific steps.
- **resource**: "Bun test docs: https://bun.sh/docs/cli/test" — a link or tool worth bookmarking for future sessions.

### Knowledge Capture — TodoWrite Checkpoints

Every task plan with 3+ todos **MUST** include a final todo: **"Capture learnings → knowledge base"**.
- This todo is the last item in every plan, marked `pending` until all other todos are done
- When you reach it: review what happened during the task and store anything worth keeping
- If nothing is worth storing, mark it completed and move on — but you must explicitly consider it
- Do NOT batch this with other work. It is its own step.

### Knowledge Capture — Trigger Rules

These are concrete signals that **MUST** trigger a `knowledge-store` call immediately (not deferred to end-of-session):

| Trigger | Kind | Example |
|---------|------|---------|
| You looked something up twice in the same session | **reference** | "The `users` table uses `uuid` not `serial` for PK" |
| User corrects you or says "no, use X instead" | **personalization** | "User prefers named exports over default exports" |
| You hit an error/gotcha that wasn't obvious | **observation** | "Bun test --watch doesn't re-run on .json changes" |
| You and the user weigh options and pick one | **decision** | "Chose Drizzle over Prisma — better Bun support" |
| You discover a multi-step workflow by doing it | **procedure** | "Deploy: build → test → tag → push → deploy script" |
| A useful URL comes up in conversation or search | **resource** | "Bun SQLite docs: https://bun.sh/docs/api/sqlite" |
| User says "always", "never", "I prefer", "I like" | **personalization** | Capture verbatim preference |

⚠️ **Store the note the moment the trigger fires** — do not wait until end of task or session.

### Knowledge Capture — Breakpoint Prompts

At these natural breakpoints, **proactively ask the user**: *"Anything worth saving before we move on?"*

1. **After finishing a complex debug session** (>3 back-and-forth cycles to find the fix)
2. **After making an architectural or technology choice**
3. **After completing a multi-step task** (the "Capture learnings" todo reminds you, but ask the user too)
4. **When the user signals a topic change** ("ok, now let's work on X")

Keep the prompt lightweight — one line, not a paragraph. If the user says no, move on immediately.

### Before Ending a Session
- Review the conversation for uncaptured knowledge:
  - Did you discover any non-obvious behavior, gotchas, or edge cases?
  - Did the user express or imply a preference you haven't stored?
  - Did you make or validate a technical decision worth recording?
  - Did you establish a workflow that could be reused?
- Store anything a future agent would benefit from knowing.

### Maintenance
- Use `knowledge-maintain stats` to check KB health
- Use `knowledge-maintain review` to surface stale notes for cleanup
