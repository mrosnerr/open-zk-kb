// LogAppender.ts - Append-only operations log for project notes
// Pure string formatting. No LLM, no judgment.

function formatDate(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

export function buildLogEntry(event: string, date: Date = new Date()): string {
  const sanitized = event.replace(/[\r\n]+/g, ' ').trim();
  return `- **${formatDate(date)}** — ${sanitized}`;
}

export function buildInitialLogContent(project: string, entry: string): string {
  const projectName = project.charAt(0).toUpperCase() + project.slice(1);
  return `# ${projectName} Operations Log\n\n${entry}`;
}

export function appendToLogContent(existingContent: string, entry: string): string {
  return `${existingContent.trimEnd()}\n${entry}`;
}

export function buildGlobalLogEntry(project: string | null, event: string, date: Date = new Date()): string {
  const sanitized = event.replace(/[\r\n]+/g, ' ').trim();
  return `- **${formatDate(date)}** — [${project ?? 'system'}] ${sanitized}`;
}

export function buildInitialGlobalLogContent(entry: string): string {
  return `# Operations Log\n\n${entry}`;
}
