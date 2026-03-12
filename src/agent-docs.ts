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

### Before Work
- \`knowledge-search\` for relevant context (preferences, decisions, patterns)

### Storing Knowledge
Use \`knowledge-store\` with one concept per note. Include \`summary\` (one-line takeaway) and \`guidance\` (imperative instruction for future agents).

**Kinds** (with example notes):
- **personalization** — "User prefers Bun over Node.js for all runtime tasks"
- **decision** — "Chose FTS5 over trigram search because..."
- **observation** — "Bun's globalThis.fetch includes \`preconnect\` — use \`as any\` cast"
- **reference** — "getStaleNotes filters on \`created_at\`, not \`updated_at\`"
- **procedure** — "Release: \`bun run release\` → bumps version, changelog, PR"
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
- \`knowledge-maintain stats\` — KB health | \`knowledge-maintain review\` — stale notes
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
