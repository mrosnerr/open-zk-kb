# Review Core

The `review` module is an internal, read-only evaluation boundary. Rules use immutable `NoteFacts` snapshots and emit structured findings; renderers remain responsible for the existing user-facing text. Built-in rule IDs use `<profile>.<name>` (for example `lifecycle.review-due`) and versions are separate from fingerprints. This module has no public tool, persistence, or plugin contract.

## Graph profile (`graph.ts`)

Alongside the per-note evaluator (`registry.ts`), `graph.ts` selects closed
built-in graph rules before materialization, plans their shared neutral fact
dependencies, and evaluates each rule from its declared frozen fact slice.
The rules reuse the same `finalizeFinding()`, canonical fingerprint, grouping,
and deterministic-order contracts:

- `links.broken` — `warning` / `invariant`. An authored wikilink occurrence
  that cannot be resolved. Evidence carries the source title, normalized
  target, and one-based line; logical identity is
  `[sourceId, target, occurrence offset]` so repeated occurrences stay
  distinct. This is the only actionable graph rule.
- `links.unlinked` — `info` / `heuristic`. An active non-structural note with
  no authored outgoing candidate and no authored incoming edge in a complete
  graph. Identity is the isolated note id. Advisory: a linking candidate, not
  a confirmed defect.
- `links.reciprocal-missing` — `info` / `heuristic`. A resolved source→target
  edge with no authored reverse edge and no publication-edge exemption.
  Identity is the ordered `[sourceId, targetId]` pair. Advisory even though
  edge absence is computed exactly, because expecting reciprocity is a
  judgment call.

Graph rules receive only frozen plain graph facts — never a reader, resolver,
path, repository, database, clock, telemetry, or mutation handle. Results are
deep-frozen, ephemeral, and never persisted; no rule emits a repair callback.
`materializeGraphReview()` never loads rules or providers from files,
configuration, plugins, or the network. Baseline/delta persistence and semantic related-link
candidates are deliberately deferred.

## Contextual graph fact planning

Contextual maintenance selects built-in graph rules before reading documents. A
closed dependency plan materializes contextual occurrences, resolution outcomes,
deduplicated active edges, and applicability only when required. Provider values
are invocation-local, deeply frozen neutral data; broken-link, isolation,
completeness, reciprocity, and publication-edge policy lives in the formal rules.
Identical inputs use source/occurrence order and stable dependency ordering.

Only explicit `unlinked`, `broken-links`, and `link-health` maintenance calls use
this pipeline. Persisted link synchronization, ordinary health, rebuild and
migration paths, and extension lifecycle hooks retain their existing behavior.
