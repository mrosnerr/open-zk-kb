// related-section.ts - Provenance-marked "## Related" sections
//
// System-generated Related sections carry an exact HTML-comment marker as the
// first line of the section body. Only marked trailing sections are treated as
// system-owned; unmarked "## Related" sections are authored content and must
// round-trip verbatim. Legacy unmarked sections stay authored because their
// provenance cannot be recovered without unsafe content migration.

import { extractWikiLinkIds } from './utils/wikilink.js';

/** Exact marker identifying a system-generated Related section body. */
export const GENERATED_RELATED_MARKER = '<!-- zk:related -->';

// Matches the marked trailing section: heading, marker line, then bullet links.
const MARKED_TRAILING_RELATED_SECTION =
  /(?:^|\n{1,2})## Related[ \t]*\n(?:[ \t]*\n)?<!-- zk:related -->[ \t]*\n(?:- .*(?:\n|$))+[ \t]*$/u;

/** Render the body of a generated Related section (marker plus bullet links). */
export function renderGeneratedRelatedBody(links: string[]): string {
  return [GENERATED_RELATED_MARKER, ...links.map(link => `- ${link}`)].join('\n');
}

/** Render a full generated Related section, heading included. */
export function renderGeneratedRelatedSection(links: string[]): string {
  return `## Related\n\n${renderGeneratedRelatedBody(links)}`;
}

/** True when the section body was produced by this system. */
export function isGeneratedRelatedBody(body: string): boolean {
  const firstLine = body.split('\n', 1)[0];
  return firstLine === GENERATED_RELATED_MARKER;
}

/**
 * Remove the marked trailing Related section while preserving authored content,
 * including unmarked authored "## Related" sections.
 */
export function stripGeneratedRelatedSection(content: string): string {
  return content.replace(MARKED_TRAILING_RELATED_SECTION, '').trimEnd();
}

/** Note IDs linked from the marked trailing Related section, in document order. */
export function extractGeneratedRelatedIds(content: string): string[] {
  const match = MARKED_TRAILING_RELATED_SECTION.exec(content);
  if (!match) return [];
  return extractWikiLinkIds(match[0]);
}
