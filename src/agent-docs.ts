// agent-docs.ts - Inject/remove managed agent instruction blocks in client docs files
//
// Each supported client has a global "agent docs" file (e.g. ~/.claude/CLAUDE.md)
// where we insert a managed block between sentinel comments. The block teaches the
// agent how to use the open-zk-kb MCP tools effectively.

import * as fs from 'fs';
import * as path from 'path';

const START_MARKER = '<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->';
const END_MARKER = '<!-- OPEN-ZK-KB:END -->';

const AGENT_DOCS_TEMPLATE = `${START_MARKER}
## Knowledge Base (open-zk-kb)

ALWAYS use the open-zk-kb MCP tools to maintain persistent memory across sessions.

### Before Starting Work
- Search for relevant context: preferences, past decisions, patterns
  - \`knowledge-search\` with a query describing what you're about to do
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
- Include a \`summary\` (one-line takeaway) and \`guidance\` (imperative instruction for future agents).

#### What's worth capturing — examples by kind

- **personalization**: "User prefers Bun over Node.js for all runtime tasks" — captures an expressed or implied preference so future agents default correctly.
- **decision**: "Chose FTS5 over trigram search for full-text indexing because..." — records an architectural choice with rationale so it isn't revisited without cause.
- **observation**: "Bun's globalThis.fetch type includes a \`preconnect\` property that standard mocks lack — use \`as any\` cast" — a non-obvious gotcha discovered during work that will save future agents time.
- **reference**: "NoteRepository.getStaleNotes filters on \`created_at\`, not \`updated_at\`" — a factual detail about the codebase that's easy to get wrong.
- **procedure**: "To release: run \`bun run release\`, which bumps version, generates changelog, and creates a PR" — a reusable workflow with specific steps.
- **resource**: "Bun test docs: https://bun.sh/docs/cli/test" — a link or tool worth bookmarking for future sessions.

### Knowledge Capture — TodoWrite Checkpoints

Every task plan with 3+ todos **MUST** include a final todo: **"Capture learnings → knowledge base"**.
- This todo is the last item in every plan, marked \`pending\` until all other todos are done
- When you reach it: review what happened during the task and store anything worth keeping
- If nothing is worth storing, mark it completed and move on — but you must explicitly consider it
- Do NOT batch this with other work. It is its own step.

### Knowledge Capture — Trigger Rules

These are concrete signals that **MUST** trigger a \`knowledge-store\` call immediately (not deferred to end-of-session):

| Trigger | Kind | Example |
|---------|------|---------|
| You looked something up twice in the same session | **reference** | "The \`users\` table uses \`uuid\` not \`serial\` for PK" |
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
- Use \`knowledge-maintain stats\` to check KB health
- Use \`knowledge-maintain review\` to surface stale notes for cleanup
${END_MARKER}`;

/**
 * Inject the managed agent docs block into a file.
 * If the file already contains the block, it is replaced (updated).
 * If the file doesn't exist, it is created.
 * Content outside the managed block is preserved.
 */
export function injectAgentDocs(filePath: string, dryRun?: boolean): { action: 'created' | 'updated' | 'unchanged'; filePath: string } {
  let existing = '';
  const fileExists = fs.existsSync(filePath);

  if (fileExists) {
    existing = fs.readFileSync(filePath, 'utf-8');
  }

  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  let newContent: string;
  let action: 'created' | 'updated' | 'unchanged';

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing block
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + END_MARKER.length);
    const candidate = before + AGENT_DOCS_TEMPLATE + after;

    if (candidate === existing) {
      return { action: 'unchanged', filePath };
    }

    newContent = candidate;
    action = 'updated';
  } else if (fileExists) {
    // Append to existing file
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : existing.length > 0 ? '\n' : '';
    newContent = existing + separator + AGENT_DOCS_TEMPLATE + '\n';
    action = 'updated';
  } else {
    // Create new file
    newContent = AGENT_DOCS_TEMPLATE + '\n';
    action = 'created';
  }

  if (!dryRun) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, newContent, 'utf-8');
  }

  return { action, filePath };
}

/**
 * Remove the managed agent docs block from a file.
 * Content outside the managed block is preserved.
 * If the file becomes empty (or whitespace-only) after removal, it is deleted.
 */
export function removeAgentDocs(filePath: string, dryRun?: boolean): { action: 'removed' | 'not-found' | 'file-deleted'; filePath: string } {
  if (!fs.existsSync(filePath)) {
    return { action: 'not-found', filePath };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    return { action: 'not-found', filePath };
  }

  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + END_MARKER.length);

  // Clean up: collapse excessive whitespace at the join point
  let newContent = (before + after).replace(/\n{3,}/g, '\n\n').trim();

  if (!dryRun) {
    if (newContent.length === 0) {
      fs.unlinkSync(filePath);
      return { action: 'file-deleted', filePath };
    }
    fs.writeFileSync(filePath, newContent + '\n', 'utf-8');
  } else if (newContent.length === 0) {
    return { action: 'file-deleted', filePath };
  }

  return { action: 'removed', filePath };
}
