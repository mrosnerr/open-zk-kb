// utils/wikilink.ts - Centralized wiki-link formatting and parsing
//
// Obsidian wiki-link format: [[slug#heading|Display Text]]
// - slug:    full filename without .md (e.g. "202502071922-opencode-tool-development-patterns")
// - heading: optional anchor to a heading within the note
// - display: optional display text shown instead of slug
//
// Examples:
//   [[202502071922-opencode-tool-development-patterns|OpenCode Tool Development Patterns]]
//   [[202602081523-knowledge-capture-plugin-roadmap#Sprint 1|Sprint 1: Foundation]]

// ---------- Types ----------

export interface WikiLink {
  /** Full slug (filename without .md), e.g. "202502071922-opencode-tool-development-patterns" */
  slug: string;
  /** Note ID extracted from slug, e.g. "202502071922" */
  id: string;
  /** Optional heading anchor, e.g. "Sprint 1" */
  heading?: string;
  /** Optional display text */
  display?: string;
}

export interface WikiLinkFormatOptions {
  /** Note ID (timestamp), e.g. "202502071922" */
  id: string;
  /** Note slug suffix (kebab-case title), e.g. "opencode-tool-development-patterns" */
  slugSuffix?: string;
  /** Optional heading anchor */
  heading?: string;
  /** Display text - strongly recommended */
  display?: string;
}

// ---------- Formatting ----------

/**
 * Build a full slug from id + slugSuffix.
 * e.g. ("202502071922", "opencode-tool-dev") => "202502071922-opencode-tool-dev"
 */
export function buildSlug(id: string, slugSuffix?: string): string {
  return slugSuffix ? `${id}-${slugSuffix}` : id;
}

/**
 * Format a wiki-link string: [[slug#heading|Display Text]]
 *
 * Always uses the pipe-display format when display text is provided.
 */
export function formatWikiLink(opts: WikiLinkFormatOptions): string {
  const slug = buildSlug(opts.id, opts.slugSuffix);
  let target = slug;
  if (opts.heading) {
    target += `#${opts.heading}`;
  }
  if (opts.display) {
    return `[[${target}|${opts.display}]]`;
  }
  return `[[${target}]]`;
}

/**
 * Convenience: build a wiki-link from a NoteMetadata-like object.
 * Extracts slug suffix from the note's path or falls back to slugifying the title.
 */
export function formatNoteLink(
  note: { id: string; path?: string; title?: string },
  opts?: { heading?: string; display?: string }
): string {
  const slugSuffix = extractSlugSuffix(note.id, note.path);
  return formatWikiLink({
    id: note.id,
    slugSuffix,
    heading: opts?.heading,
    display: opts?.display ?? note.title,
  });
}

// ---------- Parsing ----------

/** Regex that matches any [[...]] wiki-link */
export const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

/**
 * Parse a single wiki-link inner text (without brackets) into components.
 *
 * "202502071922-opencode-tool-dev#Heading|Display"
 *  => { slug: "202502071922-opencode-tool-dev", id: "202502071922", heading: "Heading", display: "Display" }
 */
export function parseWikiLink(inner: string): WikiLink {
  // Split on pipe first: target|display
  const pipeIdx = inner.indexOf('|');
  let target: string;
  let display: string | undefined;
  if (pipeIdx !== -1) {
    target = inner.substring(0, pipeIdx).trim();
    display = inner.substring(pipeIdx + 1).trim() || undefined;
  } else {
    target = inner.trim();
  }

  // Split target on #: slug#heading
  const hashIdx = target.indexOf('#');
  let slug: string;
  let heading: string | undefined;
  if (hashIdx !== -1) {
    slug = target.substring(0, hashIdx).trim();
    heading = target.substring(hashIdx + 1).trim() || undefined;
  } else {
    slug = target;
  }

  // Extract numeric ID from slug (first 12-digit timestamp)
  const idMatch = slug.match(/^(\d{12})/);
  const id = idMatch ? idMatch[1] : slug;

  return { slug, id, heading, display };
}

/**
 * Extract all wiki-links from content, returning parsed components.
 */
export function extractWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  const pattern = new RegExp(WIKILINK_PATTERN.source, 'g');
  let match;
  while ((match = pattern.exec(content)) !== null) {
    links.push(parseWikiLink(match[1]));
  }
  return links;
}

/**
 * Extract just the target IDs from wiki-links in content.
 * This is the most common use case for link resolution.
 */
export function extractWikiLinkIds(content: string): string[] {
  return extractWikiLinks(content).map(link => link.id);
}

/**
 * Extract just the target slugs from wiki-links in content.
 * Useful for broken-link detection (match against filenames).
 */
export function extractWikiLinkSlugs(content: string): string[] {
  return extractWikiLinks(content).map(link => link.slug);
}

// ---------- Helpers ----------

/**
 * Strip wiki-link brackets for plain text display.
 * Uses display text when available, otherwise the slug.
 *
 * "some text [[202502071922-foo|Foo Bar]] here"
 *  => "some text Foo Bar here"
 */
export function stripWikiLinks(content: string): string {
  return content.replace(WIKILINK_PATTERN, (_match, inner) => {
    const parsed = parseWikiLink(inner);
    return parsed.display ?? parsed.slug;
  });
}

/**
 * Extract the slug suffix from a note path.
 * e.g. "/.kb/202502071922-opencode-tool-development-patterns.md" => "opencode-tool-development-patterns"
 */
export function extractSlugSuffix(noteId: string, notePath?: string): string | undefined {
  if (!notePath) return undefined;
  const filename = notePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
  const prefix = `${noteId}-`;
  if (filename.startsWith(prefix)) {
    return filename.substring(prefix.length);
  }
  return undefined;
}

export default {
  formatWikiLink,
  formatNoteLink,
  parseWikiLink,
  extractWikiLinks,
  extractWikiLinkIds,
  extractWikiLinkSlugs,
  stripWikiLinks,
  buildSlug,
  extractSlugSuffix,
  WIKILINK_PATTERN,
};
