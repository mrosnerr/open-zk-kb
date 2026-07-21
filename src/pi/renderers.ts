import type { AgentToolResult, Theme, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { ICONS } from './renderer/constants.js';
import { WidthClamp } from './renderer/width-clamp.js';

interface ToolRenderContext {
  args: Record<string, unknown>;
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
}

type RenderResultFn = (
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
) => Component;

class WidthAwareResult implements Component {
  constructor(private readonly renderLines: (width: number) => string[]) {}
  invalidate(): void {}
  render(width: number): string[] {
    return this.renderLines(Math.max(1, width));
  }
}

function sanitizeTerminalText(value: string): string {
  // Tool output may contain terminal control sequences from stored or remote content.
  const osc = new RegExp(String.raw`\x1b\][^\x07]*(?:\x07|$)`, 'g');
  const csi = new RegExp(String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|[()][0-2A-Za-z])`, 'g');
  return value
    .replace(osc, '')
    .replace(csi, '')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('');
}

function stripXmlMarkup(value: string): string {
  // Strip protocol XML markup only after a note envelope has parsed successfully.
  return sanitizeTerminalText(value)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[^>]*\?>/g, '')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<![^>]*>/g, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '');
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
    .map((part) => sanitizeTerminalText(part.text))
    .join('\n');
}

function viewport(renderLines: (width: number) => string[]): Component {
  return new WidthClamp(new WidthAwareResult(renderLines));
}

function fixedLines(values: string[]): Component {
  return viewport((width) => values.map((value) => truncateToWidth(value, width, '…')));
}

function wrappedLines(values: string[]): Component {
  return viewport((width) => values.flatMap((value) => wrapTextWithAnsi(value, width)));
}

function raw(text: string): Component {
  return wrappedLines(sanitizeTerminalText(text).split('\n'));
}

function errorResult(text: string, theme: Theme): Component {
  const output = sanitizeTerminalText(text).split('\n');
  output[0] = theme.fg('error', `${ICONS.error} ${output[0] || 'Tool failed'}`);
  return wrappedLines(output);
}

function parseSections(text: string): Array<[string, string]> {
  const sections: Array<[string, string]> = [];
  let heading: string | undefined;
  let body: string[] = [];

  for (const line of text.split('\n')) {
    const match = line.match(/^#{1,3}\s+(.+)$/);
    if (match) {
      if (heading) sections.push([heading, body.join('\n').trim()]);
      heading = match[1];
      body = [];
    } else if (heading) {
      body.push(line);
    }
  }
  if (heading) sections.push([heading, body.join('\n').trim()]);
  return sections;
}

function sectionBody(sections: Array<[string, string]>, title: string): string {
  return sections.find(([heading]) => heading === title)?.[1] ?? '';
}

function expandedSections(header: string, sections: Array<[string, string]>, theme: Theme): Component {
  const output = [theme.fg('success', header)];
  for (const [title, body] of sections) {
    output.push('', theme.bold(title));
    if (body) output.push(...body.split('\n'));
  }
  return wrappedLines(output);
}

interface ParsedNote {
  id: string;
  kind: string;
  status: string;
  summary: string;
  guidance: string;
  content: string;
  tags: string;
}

function parseNotes(text: string): ParsedNote[] {
  const starts = [...text.matchAll(/^<note\s+([^>\n]*)>/gm)];
  const notes: ParsedNote[] = [];

  for (const [index, match] of starts.entries()) {
    const openingEnd = (match.index ?? 0) + match[0].length;
    const segmentEnd = starts[index + 1]?.index ?? text.length;
    const segment = text.slice(openingEnd, segmentEnd);
    const closingOffset = segment.lastIndexOf('</note>');
    if (closingOffset < 0) return [];
    const body = segment.slice(0, closingOffset);
    const value = (name: string): string => {
      const opening = `<${name}>`;
      const closing = `</${name}>`;
      const valueStart = body.indexOf(opening);
      const valueEnd = body.lastIndexOf(closing);
      return valueStart >= 0 && valueEnd >= valueStart + opening.length
        ? body.slice(valueStart + opening.length, valueEnd).trim()
        : '';
    };
    const attribute = (name: string): string =>
      match[1].match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';
    const note = {
      id: attribute('id'),
      kind: attribute('kind'),
      status: attribute('status'),
      tags: attribute('tags'),
      summary: stripXmlMarkup(value('summary')),
      guidance: stripXmlMarkup(value('guidance')),
      content: stripXmlMarkup(value('content')),
    };
    if (!note.summary) return [];
    notes.push(note);
  }

  return notes;
}

function searchResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const text = textOf(result);
  if (context.isPartial && !context.isError) return raw(text);
  if (context.isError) return errorResult(text, theme);

  const notes = parseNotes(text);
  if (notes.length === 0) {
    if (/no matching notes|no notes/i.test(text)) {
      const query = sanitizeTerminalText(String(context.args.query ?? ''));
      return fixedLines([theme.fg('dim', `${ICONS.search} No results${query ? ` for "${query}"` : ''}`)]);
    }
    return raw(text);
  }

  const query = sanitizeTerminalText(String(context.args.query ?? ''));
  const count = `${notes.length} result${notes.length === 1 ? '' : 's'}`;
  const output = [theme.fg('success', `${ICONS.search} ${count}${query ? ` for "${query}"` : ''}`)];
  for (const note of notes) {
    output.push(`${theme.fg('dim', note.kind)}  ${theme.bold(note.summary)}`);
    if (options.expanded) {
      if (note.guidance) output.push(theme.fg('dim', `▹ ${note.guidance}`));
      if (note.content) output.push(...note.content.split('\n'));
      const metadata = [note.status, note.id, note.tags ? `tags: ${note.tags}` : ''].filter(Boolean).join(' · ');
      if (metadata) output.push(theme.fg('muted', metadata));
    }
  }
  return options.expanded ? wrappedLines(output) : fixedLines(output);
}

function firstNonHeadingParagraph(content: string): string {
  for (const paragraph of content.split(/\n\s*\n/)) {
    const value = paragraph
      .split('\n')
      .filter((line) => !/^\s*#{1,6}\s+/.test(line))
      .join(' ')
      .trim();
    if (value) return value;
  }
  return '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(sanitizeTerminalText)
    : [];
}

function storeResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const text = textOf(result);
  if (context.isPartial && !context.isError) return raw(text);
  if (context.isError) return errorResult(text, theme);

  const match = text.match(/^(Stored|Updated|Created)\s+(\w+):\s+"([^"]+)"\s*→\s*(\S+)/m);
  if (!match) return raw(text);

  const [, operation, responseKind, responseTitle, id] = match;
  const title = sanitizeTerminalText(String(context.args.title ?? responseTitle));
  const kind = sanitizeTerminalText(String(context.args.kind ?? responseKind));
  const summary = sanitizeTerminalText(String(context.args.summary ?? ''));
  const output = [
    theme.fg('success', `${ICONS.success} ${operation} "${title}"`),
    summary,
    theme.fg('dim', `${kind}${id ? ` · ${id}` : ''}`),
  ].filter(Boolean);

  if (options.expanded) {
    const guidance = sanitizeTerminalText(String(context.args.guidance ?? ''));
    const preview = sanitizeTerminalText(firstNonHeadingParagraph(String(context.args.content ?? '')));
    if (guidance) output.push('', theme.bold('Guidance'), guidance);
    if (preview) output.push('', theme.bold('Preview'), preview);

    const metadata = [
      typeof context.args.status === 'string' ? sanitizeTerminalText(context.args.status) : '',
      typeof context.args.lifecycle === 'string' ? sanitizeTerminalText(context.args.lifecycle) : '',
      typeof context.args.project === 'string' ? `project:${sanitizeTerminalText(context.args.project)}` : '',
      ...stringArray(context.args.tags),
    ].filter(Boolean);
    if (metadata.length > 0) output.push('', theme.fg('muted', metadata.join(' · ')));
  }

  return options.expanded ? wrappedLines(output) : fixedLines(output);
}

function inventoryTotal(inventory: string): number | undefined {
  const explicit = inventory.match(/\((\d+)\s+total\)/i)?.[1];
  if (explicit) return Number(explicit);
  const counts = [...inventory.matchAll(/(?:^|,\s*)(\d+)\s+[a-z]/gi)].map((match) => Number(match[1]));
  return counts.length > 0 ? counts.reduce((sum, count) => sum + count, 0) : undefined;
}

function contextResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const text = textOf(result);
  if (context.isPartial && !context.isError) return raw(text);
  if (context.isError) return errorResult(text, theme);

  const sections = parseSections(text);
  const root = sections[0]?.[0] ?? '';
  if (!/^(?:Project|Knowledge Base) Overview(?::|$)/.test(root)) return raw(text);

  const project = root.match(/^Project Overview:\s*(.+)$/)?.[1];
  const label = project ?? 'Knowledge Base';
  const inventory = sectionBody(sections, 'Inventory');
  const total = inventoryTotal(inventory);
  if (!options.expanded) {
    const output = [theme.fg('success', `${ICONS.context} ${theme.bold(label)}`)];
    if (inventory) output.push(`${total === undefined ? '' : `${total} notes · `}${inventory}`);
    return fixedLines(output);
  }

  return expandedSections(`${ICONS.context} ${label}`, sections.slice(1), theme);
}

function healthResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const text = textOf(result);
  if (context.isPartial && !context.isError) return raw(text);
  if (context.isError) return errorResult(text, theme);

  const sections = parseSections(text);
  const healthEntry = sections.find(([heading]) => /^Health\s*\(\d+\s+notes?\)$/i.test(heading));
  const total = healthEntry?.[0].match(/\((\d+)\s+notes?\)/i)?.[1];
  if (!healthEntry || !total) return raw(text);

  const root = sections[0]?.[0] ?? '';
  const project = root.match(/^Knowledge Base Stats\s+—\s+(.+)$/)?.[1];
  if (options.expanded) {
    return expandedSections(`${ICONS.health} ${project ? `Health: ${project}` : 'Vault Health'}`, sections.slice(1), theme);
  }

  const statuses = healthEntry[1]
    .split('\n')
    .map((line) => line.match(/^[-*]\s+(Fleeting|Permanent|Archived|Other[^:]*):\s*(\d+)/i))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => `${match[2]} ${match[1].toLowerCase()}`);
  const growth = sections.find(([heading]) => /^Growth(?:\s|\()/i.test(heading))?.[1] ?? '';
  const kindLabels: Record<string, string> = { personalization: 'preferences' };
  const kindOrder = ['personalization', 'decision', 'observation', 'procedure', 'reference', 'resource', 'domain'];
  const kindCounts = [...growth.matchAll(/^\s*[-*]\s+([a-z]+):\s*(\d+)\s*$/gim)]
    .map((match) => ({ kind: match[1].toLowerCase(), count: match[2] }))
    .sort((left, right) => kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind))
    .map(({ kind, count }) => `${count} ${kindLabels[kind] ?? (count === '1' ? kind : `${kind}s`)}`);
  const embedded = sectionBody(sections, 'Embeddings').match(/Embedded:\s*(\d+)\/(\d+)\s+notes?/i);
  const links = sectionBody(sections, 'Link Health');
  const linkIssue = /Issues:/i.test(links)
    ? theme.fg('warning', `${ICONS.error} ${links.replace(/^[-*]\s*/, '')}`)
    : '';
  const healthySignals = [
    embedded ? `${embedded[1]}/${embedded[2]} embedded` : '',
    /All clear/i.test(links) ? 'links healthy' : '',
  ].filter(Boolean).join(' · ');

  return fixedLines([
    theme.fg('success', `${ICONS.health} ${theme.bold(`${project ? `${project} · ` : ''}${total} notes`)}`),
    statuses.join(' · '),
    kindCounts.join(' · '),
    healthySignals ? theme.fg('success', `${ICONS.success} ${healthySignals}`) : '',
    linkIssue,
  ].filter(Boolean));
}

function getResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const text = textOf(result);
  if (context.isPartial && !context.isError) return raw(text);
  if (context.isError) return errorResult(text, theme);

  const note = parseNotes(text)[0];
  if (!note) return raw(text);
  const metadata = [note.kind, note.status, note.id].filter(Boolean).join(' · ');
  const output = [
    `${theme.fg('success', ICONS.get)} ${theme.bold(note.summary)}`,
    theme.fg('dim', metadata),
  ];
  if (options.expanded) {
    if (note.guidance) output.push('', theme.fg('dim', `▹ ${note.guidance}`));
    if (note.content) output.push('', ...note.content.split('\n'));
    if (note.tags) output.push('', theme.fg('muted', `tags: ${note.tags}`));
  }
  return options.expanded ? wrappedLines(output) : fixedLines(output);
}

function firstStatusLine(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/\*\*/g, '') ?? '';
}

function templateResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const text = textOf(result);
  if (context.isPartial && !context.isError) return raw(text);
  if (context.isError) return errorResult(text, theme);

  const kind = sanitizeTerminalText(String(context.args.kind ?? 'knowledge'));
  if (!options.expanded) {
    return fixedLines([theme.fg('success', `${ICONS.template} Loaded ${kind} template`)]);
  }
  return wrappedLines([
    theme.fg('success', `${ICONS.template} ${theme.bold(`${kind} template`)}`),
    ...text.split('\n'),
  ]);
}

function simpleResult(icon: string): RenderResultFn {
  return (result, options, theme, context) => {
    const text = textOf(result);
    if (context.isPartial && !context.isError) return raw(text);
    if (context.isError) return errorResult(text, theme);
    if (!text) return raw(text);
    const output = options.expanded
      ? [theme.fg('success', icon), ...text.split('\n')]
      : [`${theme.fg('success', icon)} ${firstStatusLine(text)}`];
    return options.expanded ? wrappedLines(output) : fixedLines(output);
  };
}

export const RENDER_RESULTS: Record<string, RenderResultFn> = {
  'knowledge-search': searchResult,
  'knowledge-store': storeResult,
  'knowledge-context': contextResult,
  'knowledge-health': healthResult,
  'knowledge-get': getResult,
  'knowledge-maintain': simpleResult(ICONS.maintain),
  'knowledge-mine': simpleResult(ICONS.mine),
  'knowledge-ingest': simpleResult(ICONS.ingest),
  'knowledge-template': templateResult,
  'knowledge-open': simpleResult(ICONS.open),
};
