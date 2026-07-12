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
  return `---\ncssclasses:\n  - folder-note-shell\nup: "[[Home|Home]]"\n---\n\n# \`[!!scroll-text]\` Operations Log\n\n${entry}`;
}

export function migrateGlobalLogContent(existingContent: string): string {
  let content = existingContent;
  content = content.replace(/^> \[!breadcrumb\]\n(?:> .*\n?)*/m, '');
  content = content.replace(/^# Operations Log$/m, '# `[!!scroll-text]` Operations Log');
  const fmMatch = content.match(/^---\n([\s\S]*?\n)---/);
  if (fmMatch && !fmMatch[1].includes('up:')) {
    content = content.replace(/^(---\n(?:.*\n)*?)(---)/m, '$1up: "[[Home|Home]]"\n$2');
  }
  if (!content.includes('---\n')) {
    content = `---\ncssclasses:\n  - folder-note-shell\nup: "[[Home|Home]]"\n---\n\n${content.trimStart()}`;
  }
  return content;
}
