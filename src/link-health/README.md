# Contextual Link Health

`reader.ts` is the only production adapter that touches the filesystem or
`NoteRepository`: it lists active non-structural documents, reads each raw
source file, and exposes a query that classifies a target as an indexed
document, an existing non-graph vault target, or unresolved. It never
persists contextual edges, rewrites `note_links`, or exposes a mutation
capability.

The closed planner and neutral fact providers under `review/` consume the
reader's plain values. Selected rules drive a deterministic dependency plan;
each provider executes at most once per invocation, and completed immutable
fact layers are shared across rules. No provider owns issue impact, message,
or repair policy.

## Graph semantics

- Only authored contextual wikilinks (per `markdown/contextual-facts.ts`)
  participate; frontmatter, code, and raw-HTML syntax never do.
- Broken findings preserve every occurrence (an unresolved target reported
  once per source line). Resolved edges deduplicate the source→target pair
  before incoming/outgoing/reciprocal analysis.
- An edge exists only when both endpoints are active, non-structural
  documents in the same evaluation; a link to any other existing note is a
  valid (non-broken) candidate but never a graph edge.
- Unlinked means zero authored outgoing candidates (including broken ones)
  and zero resolved incoming edges.
- One-way means a resolved edge lacks its reverse edge; a project-local
  source linking to a global target is exempt (publication edge).

## Failure handling

A document that cannot be read or whose Markdown cannot be parsed becomes a
note-ID/title-only failure — no path or content. Any failure marks the
graph incomplete and suppresses every unlinked finding, since an unknown
document could hold an unknown incoming edge to any note. A one-way finding
is suppressed when its target document failed, since the missing reverse
edge is unknown. Broken findings from successful documents remain valid
even when other documents fail.

## Formal graph rules

The `unlinked`, `broken-links`, and `link-health` actions select the closed
built-in rules in `review/graph-rules.ts` (`links.broken`, `links.unlinked`,
`links.reciprocal-missing`) before materialization. Rules own unresolved,
isolation, incomplete-scan, reciprocity, and publication-exemption policy,
so every issue has one semantic implementation site. Every graph finding
carries a stable rule id, version, evidence basis, and canonical fingerprint.
Broken occurrences are actionable invariant evidence; unlinked and
reciprocal-missing findings are explicitly advisory heuristics.

## Output limits

Rules always compute complete groups and totals; the maintenance adapters
apply a deterministic per-category display bound only after evaluation. A
positive `limit` argument sets the bound; otherwise it defaults to 20. Each
truncated category states `showing N of X` while headings, summaries, and
telemetry keep the complete evaluated count. The sanitized failure cap stays
independent of the issue-category limits.

## Status

This module has no persistence and no public tool contract. It backs the
`knowledge-maintain unlinked`, `broken-links`, and `link-health` actions
only (see `tool-handlers.ts`); `knowledge-health`, `syncLinks()`, rebuild,
and layout-migration link checks remain on the legacy persisted
`note_links` graph. Baseline/delta persistence and semantic related-link
candidates are deferred to separate changes.
