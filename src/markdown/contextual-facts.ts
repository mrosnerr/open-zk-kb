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
// navigation, or mutation capability. Its production consumer is the
// contextual-link fact provider in `src/review/graph-providers.ts`; see
// `src/markdown/README.md` for the fact boundary this module establishes.

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
    // A leading BOM is not Markdown content: remark's offsets are relative to
    // the BOM-stripped text, so parse without it and shift every parser offset
    // by `bomLength` to keep all ranges offsets into the original JS string.
    const bomLength = source.charCodeAt(0) === 0xfeff ? 1 : 0;
    const parseSource = bomLength === 0 ? source : source.slice(bomLength);
    const tree = processor.parse(parseSource) as MarkdownAstNode;
    if (hasUnterminatedLeadingFrontmatter(parseSource, tree)) {
      return Object.freeze({
        ok: false,
        reason: 'contextual-markdown-facts: unterminated leading frontmatter',
      });
    }
    const toPosition = createPositionResolver(source);

    const textSegments: ContextualTextSegment[] = [];
    const wikilinks: ContextualWikiLink[] = [];

    collectEligibleFacts(tree, source, bomLength, toPosition, textSegments, wikilinks);

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
 * Disambiguates an unterminated frontmatter opener from Markdown's valid
 * leading thematic break. Without a closing fence, report a failure only
 * when a line before the first blank boundary has a conventional unquoted
 * YAML mapping key (`key: value`), as used by note frontmatter. Otherwise the
 * leading `---` is conservatively treated as ordinary Markdown.
 */
function hasUnterminatedLeadingFrontmatter(parseSource: string, tree: MarkdownAstNode): boolean {
  const opening = LEADING_FRONTMATTER_FENCE.exec(parseSource);
  if (!opening) return false;
  const first = tree.children?.[0];
  if (first && first.type === 'yaml' && first.position?.start.offset === 0) return false;

  const afterOpening = parseSource.slice(opening[0].length);
  const beforeBlankBoundary = afterOpening.split(/\r?\n[ \t]*\r?\n/, 1)[0] ?? '';
  return beforeBlankBoundary
    .split(/\r?\n/)
    .some(line => /^[ \t]*[A-Za-z_][A-Za-z0-9_-]*[ \t]*:(?:[ \t]|$)/.test(line));
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
  bomLength: number,
  toPosition: PositionResolver,
  textSegments: ContextualTextSegment[],
  wikilinks: ContextualWikiLink[]
): void {
  if (node.type === 'text') {
    const segment = buildTextSegment(node, source, bomLength, toPosition);
    textSegments.push(segment);
    scanWikilinksInSegment(segment, toPosition, wikilinks);
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      collectEligibleFacts(child, source, bomLength, toPosition, textSegments, wikilinks);
    }
  }
}

function buildTextSegment(
  node: MarkdownAstNode,
  source: string,
  bomLength: number,
  toPosition: PositionResolver
): ContextualTextSegment {
  const position = node.position;
  if (typeof node.value !== 'string' || !position || position.start.offset === undefined || position.end.offset === undefined) {
    throw new Error('contextual-markdown-facts: text node missing value or source offsets');
  }
  const startOffset = position.start.offset + bomLength;
  const endOffset = position.end.offset + bomLength;
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
