// content-splitter.ts — Standalone content processing utilities.
//
// Splits markdown into sections by heading boundaries and extracts links.
// No dependency on ingest, store, or any MCP tool — reusable across the codebase.

export interface ContentSection {
  heading: string;
  depth: number;
  content: string;
  wordCount: number;
}

export interface ContentLink {
  url: string;
  anchor: string;
  section: string;
}

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid',
  'ref', '_ga', '_gl', 'mc_cid', 'mc_eid',
]);

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function canonicalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    for (const param of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(param.toLowerCase())) {
        url.searchParams.delete(param);
      }
    }
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function splitSections(markdown: string): ContentSection[] {
  if (!markdown || markdown.trim().length === 0) return [];

  const lines = markdown.split('\n');
  const sections: ContentSection[] = [];
  let currentHeading = '';
  let currentDepth = 0;
  let currentLines: string[] = [];
  let inFencedBlock = false;

  function flush() {
    const content = currentLines.join('\n').trim();
    if (content.length > 0) {
      sections.push({
        heading: currentHeading,
        depth: currentDepth,
        content,
        wordCount: countWords(content),
      });
    }
  }

  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFencedBlock = !inFencedBlock;
      currentLines.push(line);
      continue;
    }

    if (inFencedBlock) {
      currentLines.push(line);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      if (depth >= 2 && depth <= 3) {
        flush();
        currentHeading = headingMatch[2].trim();
        currentDepth = depth;
        currentLines = [];
        continue;
      }
    }

    currentLines.push(line);
  }

  flush();
  return sections;
}

const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

export function extractLinks(markdown: string, sourceUrl?: string): ContentLink[] {
  if (!markdown) return [];

  const lines = markdown.split('\n');
  const seen = new Set<string>();
  const links: ContentLink[] = [];
  let currentSection = '';
  let inFencedBlock = false;

  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFencedBlock = !inFencedBlock;
      continue;
    }
    if (inFencedBlock) continue;

    const headingMatch = line.match(/^#{2,3}\s+(.+)/);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
    }

    let match;
    MARKDOWN_LINK_RE.lastIndex = 0;
    while ((match = MARKDOWN_LINK_RE.exec(line)) !== null) {
      const anchor = match[1].trim();
      const rawUrl = match[2].trim();

      const canonical = canonicalizeUrl(
        rawUrl.startsWith('http') ? rawUrl : sourceUrl ? new URL(rawUrl, sourceUrl).href : rawUrl,
      );
      if (!canonical) continue;
      if (seen.has(canonical)) continue;
      seen.add(canonical);

      links.push({ url: canonical, anchor, section: currentSection });
    }
  }

  return links;
}
