// markdown/contextual-facts.ts
//
// Internal, pure contextual Markdown fact extraction.
//
// `extractContextualMarkdownFacts` accepts a raw Markdown source string and
// returns a deeply frozen, plain-object description of the eligible
// authored text and Obsidian-style wikilinks it contains. "Eligible" text
// excludes a leading YAML frontmatter fence, fenced code, inline code, and
// raw-HTML syntax spans; text between inline HTML tags remains eligible
// Markdown text (only the tag syntax itself is a raw-HTML node).
//
// The Markdown syntax tree (remark/mdast) used internally is never exposed
// to callers: the function receives only a string and returns only plain
// data, with no path, filesystem, repository, database, clock, telemetry,
// navigation, or mutation capability. It has no production consumer in this
// change; see `src/markdown/README.md` for the fact boundary this module
// establishes for a later link-health migration.

import remarkFrontmatter from 'remark-frontmatter';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { parseWikiLink, type WikiLink } from '../utils/wikilink.js';

// ---------- Public types ----------

/** Zero-based UTF-16 source position: absolute offset plus line/character. */
export interface SourcePosition {
  /** Absolute offset into the source string, in UTF-16 code units. */
  readonly offset: number;
  /** Zero-based line number. Both LF and CRLF advance one line at `\n`. */
  readonly line: number;
  /** Zero-based column on `line`, in UTF-16 code units since the line start. */
  readonly character: number;
}

/** End-exclusive `[start, end)` UTF-16 source range. */
export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

/** An eligible leaf text span, in source order. */
export interface ContextualTextSegment {
  /** Normalized mdast `text` node value (Markdown escapes/entities resolved). */
  readonly value: string;
  /** Exact `source.slice(range.start.offset, range.end.offset)`. */
  readonly rawSource: string;
  readonly range: SourceRange;
}

/** A wikilink found within a single eligible text segment. */
export interface ContextualWikiLink extends Readonly<WikiLink> {
  /** Exact `[[...]]` source; equals `source.slice(range.start.offset, range.end.offset)`. */
  readonly rawSource: string;
  readonly range: SourceRange;
}

export type LineEnding = 'none' | 'lf' | 'crlf' | 'mixed';

export interface ContextualMarkdownFacts {
  readonly ok: true;
  /** `source.length`, in UTF-16 code units. */
  readonly sourceLength: number;
  readonly lineEnding: LineEnding;
  /** Eligible leaf text segments, in source order. */
  readonly textSegments: readonly ContextualTextSegment[];
  /** Contextual wikilinks, in source order. */
  readonly wikilinks: readonly ContextualWikiLink[];
}

export interface ContextualMarkdownParseFailure {
  readonly ok: false;
  readonly reason: string;
}

export type ContextualMarkdownResult = ContextualMarkdownFacts | ContextualMarkdownParseFailure;

// ---------- Parser pipeline (private) ----------

// A fixed parse-only pipeline: no stringify/serializer is imported or invoked.
const processor = unified().use(remarkParse).use(remarkFrontmatter);

/** Matches a leading YAML frontmatter opening fence: `---` alone on line 1. */
const LEADING_FRONTMATTER_FENCE = /^---[ \t]*\r?\n/;

/** Mirrors the existing `[[...]]` wikilink shape: no `]` permitted inside. */
const WIKILINK_SCAN_PATTERN = /\[\[([^\]]+)\]\]/g;

/** Private structural view of the parser tree; parser-specific types never cross the module boundary. */
interface MarkdownAstNode {
  readonly type: string;
  readonly value?: unknown;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
  readonly children?: readonly MarkdownAstNode[];
}

// ---------- Entry point ----------

/**
 * Extract immutable contextual Markdown facts from a source string.
 *
 * Pure: accepts only a string and returns a frozen plain result. Never
 * throws; an unexpected parser failure produces a typed failure rather than
 * an unrestricted raw-text fallback.
 */
export function extractContextualMarkdownFacts(source: string): ContextualMarkdownResult {
  try {
    const tree = processor.parse(source) as MarkdownAstNode;
    const toPosition = createPositionResolver(source);

    const textSegments: ContextualTextSegment[] = [];
    const wikilinks: ContextualWikiLink[] = [];

    if (!hasUnterminatedLeadingFrontmatter(source, tree)) {
      collectEligibleFacts(tree, source, toPosition, textSegments, wikilinks);
    }

    return Object.freeze({
      ok: true,
      sourceLength: source.length,
      lineEnding: detectLineEnding(source),
      textSegments: Object.freeze(textSegments),
      wikilinks: Object.freeze(wikilinks),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------- Frontmatter eligibility ----------

/**
 * A leading `---` fence line with no matching `yaml` node at offset 0 means
 * `remark-frontmatter` could not find a closing fence. Treat the entire
 * source as ineligible through end-of-file rather than let unterminated
 * frontmatter fall through to ordinary paragraph text.
 */
function hasUnterminatedLeadingFrontmatter(source: string, tree: MarkdownAstNode): boolean {
  if (!LEADING_FRONTMATTER_FENCE.test(source)) return false;
  const first = tree.children?.[0];
  return !(first && first.type === 'yaml' && first.position?.start.offset === 0);
}

// ---------- Traversal ----------

/**
 * Depth-first, source-order traversal collecting leaf `text` nodes. Nodes
 * without a `children` array (`yaml`, `code`, `inlineCode`, `html`, `image`,
 * `imageReference`, `definition`, etc.) are leaves and are never descended
 * into, which is what excludes them from eligible text: only genuine mdast
 * `text` nodes are collected.
 */
function collectEligibleFacts(
  node: MarkdownAstNode,
  source: string,
  toPosition: PositionResolver,
  textSegments: ContextualTextSegment[],
  wikilinks: ContextualWikiLink[]
): void {
  if (node.type === 'text') {
    const segment = buildTextSegment(node, source, toPosition);
    textSegments.push(segment);
    scanWikilinksInSegment(segment, toPosition, wikilinks);
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      collectEligibleFacts(child, source, toPosition, textSegments, wikilinks);
    }
  }
}

function buildTextSegment(node: MarkdownAstNode, source: string, toPosition: PositionResolver): ContextualTextSegment {
  const position = node.position;
  if (typeof node.value !== 'string' || !position || position.start.offset === undefined || position.end.offset === undefined) {
    throw new Error('contextual-markdown-facts: text node missing value or source offsets');
  }
  const startOffset = position.start.offset;
  const endOffset = position.end.offset;
  const rawSource = source.slice(startOffset, endOffset);
  return Object.freeze({
    value: node.value,
    rawSource,
    range: Object.freeze({ start: toPosition(startOffset), end: toPosition(endOffset) }),
  });
}

// ---------- Wikilink scanning ----------

/**
 * Scans one eligible segment's exact raw source in isolation, so a match
 * can never combine brackets from separate syntax nodes. An opening `[[`
 * preceded by an odd run of backslashes is a Markdown escape and is
 * ignored.
 */
function scanWikilinksInSegment(
  segment: ContextualTextSegment,
  toPosition: PositionResolver,
  out: ContextualWikiLink[]
): void {
  const { rawSource, range } = segment;
  const baseOffset = range.start.offset;
  const pattern = new RegExp(WIKILINK_SCAN_PATTERN.source, 'g');
  let match = pattern.exec(rawSource);
  while (match !== null) {
    if (!isEscapedOpening(rawSource, match.index)) {
      const raw = match[0];
      const startOffset = baseOffset + match.index;
      const endOffset = startOffset + raw.length;
      const components = parseWikiLink(match[1]);

      out.push(
        Object.freeze({
          ...components,
          rawSource: raw,
          range: Object.freeze({ start: toPosition(startOffset), end: toPosition(endOffset) }),
        })
      );
    }
    match = pattern.exec(rawSource);
  }
}

/** True when `[[` at `openIndex` is preceded by an odd run of `\` characters. */
function isEscapedOpening(slice: string, openIndex: number): boolean {
  let backslashes = 0;
  let i = openIndex - 1;
  while (i >= 0 && slice.charCodeAt(i) === 0x5c) {
    backslashes++;
    i--;
  }
  return backslashes % 2 === 1;
}

// ---------- Positions ----------

type PositionResolver = (offset: number) => SourcePosition;

/**
 * Builds one line-start table from the original source and returns a
 * resolver converting absolute UTF-16 offsets into zero-based line/character
 * positions. Both LF and CRLF advance a line at `\n`; the `\r` stays on the
 * prior line's character count, matching JavaScript string slicing.
 */
function createPositionResolver(source: string): PositionResolver {
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x0a) {
      lineStarts.push(i + 1);
    }
  }

  return (offset: number): SourcePosition => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((lineStarts[mid] as number) <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    const lineStart = lineStarts[low] as number;
    return Object.freeze({ offset, line: low, character: offset - lineStart });
  };
}

function detectLineEnding(source: string): LineEnding {
  let hasCrlf = false;
  let hasLoneLf = false;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x0a) {
      if (i > 0 && source.charCodeAt(i - 1) === 0x0d) {
        hasCrlf = true;
      } else {
        hasLoneLf = true;
      }
    }
  }
  if (!hasCrlf && !hasLoneLf) return 'none';
  if (hasCrlf && hasLoneLf) return 'mixed';
  return hasCrlf ? 'crlf' : 'lf';
}
