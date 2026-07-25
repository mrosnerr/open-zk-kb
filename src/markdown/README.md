# Contextual Markdown Facts

`contextual-facts.ts` is an internal, pure `string -> facts` boundary. Given
a Markdown source string, `extractContextualMarkdownFacts` returns a deeply
frozen plain result describing the eligible authored text and Obsidian-style
`[[wikilink]]` occurrences it contains. It receives no path, filesystem,
repository, database, clock, telemetry, navigation, or mutation capability,
and performs none of those operations. Repeated calls on identical source
bytes return deeply equal facts in deterministic source order.

The parser (`unified` + `remark-parse` + `remark-frontmatter`) and its mdast
syntax tree are private implementation detail; no dependency-specific type
or node ever appears in the returned facts. Only the existing
`parseWikiLink()` component parser (`utils/wikilink.ts`) is reused for
wikilink target/heading/display parsing.

## Eligible vs. excluded context

Eligible: prose paragraphs, headings, emphasis/strong text, block quotes,
list items, and Markdown link labels. Text between raw inline HTML tags
(e.g. `<span>[[slug]]</span>`) is eligible Markdown text — only the tag
syntax itself is excluded.

Excluded: a leading YAML frontmatter fence, fenced code, inline code, raw
HTML node spans (including HTML blocks), image alt text, and link
definition destinations/titles. An unterminated leading frontmatter fence
(`---` with no closing fence) is treated conservatively as ineligible
through end-of-file, since a malformed fence must not let generated
metadata read as authored prose.

## Source locations

Every text segment and wikilink carries a file-relative, zero-based,
end-exclusive `[start, end)` range. Offsets and `character` positions count
UTF-16 code units, matching plain JavaScript string slicing; `line` is
zero-based and advances once per `\n` (CRLF's `\r` stays on the prior line's
character count). `source.slice(range.start.offset, range.end.offset)`
always equals a wikilink's exact `rawSource`. A text segment's `value` is
the normalized mdast value; its `range`/`rawSource` are the exact,
unnormalized source span, since Markdown escapes and character references
can make `value` shorter than the raw slice.

Wikilink scanning operates independently on each eligible segment's raw
slice: a match cannot span two syntax nodes, cannot contain `]`, and is
skipped when its opening `[[` is preceded by an odd run of `\`.

## Failure mode

If the parser unexpectedly cannot produce a syntax tree (or an eligible
text node is missing source offsets), the function returns a typed
`{ ok: false, reason }` failure. There is no raw-text fallback.

## Status

This module has no production consumer yet. It is not called from any
store, update, rebuild, link-synchronization, startup, health, or
maintenance path. It is a groundwork layer for a later, separately reviewed
link-health migration.
