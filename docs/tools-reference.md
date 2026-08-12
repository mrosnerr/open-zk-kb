# Tools Reference

open-zk-kb exposes ten MCP tools. Your agent calls these automatically based on injected [instructions](setup-guide.md#agent-instructions) — you rarely need to invoke them manually.

| Tool | What it does |
|------|-------------|
| [`knowledge-store`](#knowledge-store) | Save decisions, preferences, procedures, and insights |
| [`knowledge-ingest`](#knowledge-ingest) | Extract article content from URLs or HTML into structured markdown |
| [`knowledge-search`](#knowledge-search) | Search the knowledge base before starting work |
| [`knowledge-maintain`](#knowledge-maintain) | Review, promote, archive, and rebuild notes |
| [`knowledge-health`](#knowledge-health) | Vault health metrics, staleness distribution, growth rates, and infrastructure status |
| [`knowledge-context`](#knowledge-context) | Get a project overview of local and explicitly global knowledge |
| `knowledge-template` | Get the canonical note template for a specific kind |
| [`knowledge-mine`](#knowledge-mine) | Bulk-screen candidates and apply an explicitly reviewed create/update/skip plan |
| `knowledge-open` | Open the vault in [Obsidian](obsidian.md) with a scaffolded theme, plugins, and homepage |
| [`knowledge-get`](#knowledge-get) | Retrieve a single note by its exact ID |

Notes use [9 kinds with lifecycle management](note-lifecycle.md). For configuration options, see the [Configuration Reference](configuration.md).

---

## knowledge-store

Store knowledge in the persistent knowledge base. One concept per note.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Note title — concise, descriptive |
| `content` | string | Yes | Note content — the knowledge to store |
| `kind` | enum | Yes | One of: `personalization`, `reference`, `decision`, `procedure`, `resource`, `observation`, `domain`. Note: `index` and `log` are auto-generated and cannot be created manually |
| `summary` | string | Yes | One-line present-tense key takeaway |
| `guidance` | string | Yes | Imperative actionable instruction for future agents |
| `status` | enum | No | Override default: `fleeting`, `permanent`, or `archived`. Defaults based on kind (see [Note Lifecycle](note-lifecycle.md)) |
| `lifecycle` | enum | No | `living` (mutable), `snapshot` (immutable), or `append-only`. Defaults based on kind |
| `tags` | string[] | No | Tags for categorization |
| `project` | string | Yes | Current project; storage adds exactly one `project:<name>` tag |
| `client` | string | No | Client identifier (e.g. `claude-code`, `opencode`). Auto-detected from content when omitted |
| `related` | string[] | No | IDs of related notes to link via `[[wikilinks]]` |
| `model` | string | No | Your model identifier. Enables richer responses for capable models |
| `dryRun` | boolean | No | Return reviewed collision evidence and operation-specific confirmation tokens without mutation |
| `disposition` | enum | No | Explicit intent: `create`, `update`, or `skip` |
| `noteId` | string | For update | Exact visible target ID for an update |
| `expectedUpdatedAt` | number | For update | Optimistic version from the selected target |
| `confirm` / `token` | boolean / string | For confirmed mutation | Confirm the exact reviewed create or target-specific update operation |

### Domain note constraints

When `kind: "domain"`:
- **Requires** `project` parameter — rejected without one
- **One per project** — storing a second domain note for the same project returns an error with the existing note's ID
- Default status: `permanent`, default lifecycle: `living`

### Reviewed create and update flow

A low-risk legacy create remains a one-call operation. When exact-title, near-duplicate, or high-confidence semantic evidence is present, the call is mutation-free and returns evidence plus separate tokens for creating a new note and updating each eligible living or append-only target. Review that evidence, choose `create`, `update`, or `skip`, then repeat the unchanged candidate with `confirm: true` and the token for that exact operation. Tokens are bound to the candidate, visible snapshot, target, and target version; stale tokens fail before mutation.

Updates preserve the target's ID, path, creation time, kind, status, lifecycle, project/client scope, tags, and related links. Snapshot and archived targets are rejected. Append-only updates must be a strict metadata-preserving content extension. Ambiguous transport failures have no idempotency guarantee: reconcile the note by ID or search before retrying.

### What happens

1. Screens the complete visible active non-structural snapshot for exact-title, SimHash, and compatible-model semantic evidence
2. Generates a timestamped ID (`YYYYMMDDHHmmss00`) for a create, or preserves the selected ID for an update
3. Creates or updates the Markdown file with YAML frontmatter at `{vault}/{id}-{slug}.md`
4. Indexes the note in SQLite for full-text and metadata search
5. Generates a local embedding vector for semantic search (if enabled)
6. Tracks wikilink relationships in the `note_links` table
7. Uses the required `project` to rebuild that project's `index` when `navigation.enableProjectIndex` is enabled and append to its `log` when `navigation.enableProjectLog` is enabled

### Auto-generated notes

When storing a project-scoped note, two structural notes are maintained automatically:

- **index** — a living project shell page maintained by the server. It is primarily a human-facing Obsidian navigation surface and may use Dataview to render live note lists and counts inside the shell. Rebuilt on every store, archive, promote, delete, or rebuild event. One per project.
- **log** — an append-only chronological log of events (stores, promotions, archives, deletions, rebuilds). It is primarily a human-facing Obsidian activity surface. Each entry has a bold date prefix. One per project.

These notes are auto-generated by the server when `navigation.enableProjectIndex` / `navigation.enableProjectLog` are enabled (both default to `true`). Agents cannot create `index` or `log` notes manually via `knowledge-store`.

### Example

```json
{
  "title": "Prefer Bun over Node for this project",
  "content": "The project uses bun:sqlite and Bun-specific APIs. Node.js is blocked via engines field in package.json (node >=99.0.0).",
  "kind": "decision",
  "summary": "Bun is the required runtime — Node.js is intentionally blocked.",
  "guidance": "Never suggest Node.js alternatives. Always use bun commands.",
  "tags": ["runtime", "tooling"],
  "project": "open-zk-kb"
}
```

---

## knowledge-mine

Bulk-screen up to 50 ordered candidates, then apply only explicitly reviewed dispositions.

1. Call with `dry_run: true` (the default) and no dispositions. The result classifies each candidate as STORE, SKIP, or REVIEW and returns a deterministic candidate key.
2. Submit a partial or complete candidate-keyed disposition list using `store`, `update`, or `skip`. Unspecified and REVIEW candidates remain unchanged. Update dispositions also require `noteId` and `expectedUpdatedAt`.
3. The mutation-free plan preview returns normalized operation tokens and one batch token bound to the unchanged ordered candidates, dispositions, selected targets, versions, and reviewed evidence.
4. Apply the same candidates and dispositions with `dry_run: false`, `confirm: true`, and that batch token.

Calling `dry_run: false` without dispositions now returns a zero-mutation migration response; it never auto-stores STORE or REVIEW classifications. Unknown, duplicate, edited, or reordered candidate keys and conflicting updates fail closed. Accepted operations execute in original candidate order under one vault mutation lock. If a later operation fails after an earlier write, the response reports the completed prefix and ambiguous remainder; completed writes are not rolled back, so reconcile vault state before retrying.

---

## knowledge-ingest

Extract article content as clean markdown from a URL or pre-fetched HTML. Returns title, content, word count, and metadata. Deterministic — no LLM dependency.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | No* | URL to fetch and extract content from. Must be `http://` or `https://` |
| `html` | string | No* | Raw HTML to extract from. Use when you already fetched the page via another tool |

\* At least one of `url` or `html` must be provided. When both are provided, `html` is used for extraction and `url` is used for resolving relative links.

### What happens

1. **If `url` only** — fetches the page with SSRF protection (literal private IP/hostname pattern blocking, redirect validation, streaming size limits), then extracts
2. **If `html` only** — extracts directly from provided HTML (no network request). Pass `url` alongside `html` when possible — without it, relative links cannot be resolved
3. **If both** — extracts from `html`, uses `url` for relative link resolution
4. Extracts article content using Mozilla Readability (same engine as Firefox Reader View)
5. Converts to clean markdown (headings, lists, links preserved; images, iframes, nav stripped)
6. Returns structured metadata: title, word count, byline, excerpt, site name

### Usage patterns

**Preferred: Pre-fetched HTML** — use your web tools (Playwright, Exa, web_fetch) to fetch first, then pass the HTML for extraction. This handles JavaScript-rendered pages, bot-protected sites, and authenticated content:
```json
{
  "url": "https://example.com/blog/article",
  "html": "<html>...</html>"
}
```

**HTML only** — when you have HTML but no source URL:
```json
{ "html": "<html><body><article>...</article></body></html>" }
```

**Fallback: Direct URL** — when no web tools are available. The built-in fetcher is basic — see limitations below:
```json
{ "url": "https://example.com/blog/article" }
```

### Built-in fetcher limitations

The `url`-only path uses a basic HTTP client. It **cannot** handle:

- JavaScript-rendered pages (SPAs, React, Vue, Next.js client-side)
- Bot-protected sites (CloudFlare, Akamai, CAPTCHAs)
- Authenticated or paywalled content
- Cookie consent modals
- Lazy-loaded or infinite-scroll content

For these cases, fetch the page with a browser-capable tool and pass the `html` parameter.

### Security notes

- **SSRF protection** blocks literal private/reserved IP addresses and hostname patterns (localhost, 10.x, 100.64-127.x, 172.16-31.x, 192.168.x, 169.254.x, IPv6 loopback/link-local/unique-local, IPv4-mapped IPv6). Each initial request and redirect hop is validated before fetching, including DNS resolution of hostnames with every returned address checked against private/reserved ranges.
- **Known limitation**: DNS is resolved before each fetch, but there remains a time-of-check/time-of-use window between validation and the HTTP connection. A hostname could theoretically rebind after validation but before `fetch()` connects.
- **Extracted links** are filtered to exclude private/reserved IP targets before being shown in output.
- **URL credentials** (userinfo) are stripped from extracted links.

### Workflow

The intended workflow is a two-step pipeline:

1. *(If you have web tools)* Fetch with Playwright/Exa/web_fetch → pass to `knowledge-ingest(html: ...)`
2. `knowledge-ingest` → extract and review content
3. `knowledge-store` → save as a knowledge base note

The tool extracts content but does **not** create notes automatically. This keeps summarization and note structuring at the agent layer.

---

## knowledge-search

Search the knowledge base using full-text search and semantic similarity. Returns matching notes ranked by relevance.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Natural language query or keywords |
| `kind` | enum | No | Filter by note kind |
| `status` | enum | No | Filter by status: `fleeting`, `permanent`, or `archived` |
| `lifecycle` | enum | No | Filter by lifecycle: `living`, `snapshot`, or `append-only` |
| `project` | string | Yes | Current project visibility boundary |
| `client` | string | No | Your client name — excludes notes scoped to other clients |
| `tags` | string[] | No | Filter by tags (all must match) |
| `limit` | number | No | Max results: 10 in `full`; 5 by default and at most 10 in `compact` |
| `mode` | enum | No | `full` returns legacy full-content results (default, for compatibility); `compact` returns bounded evidence cards |

### Response modes and retrieval flow

`full` is the default and preserves the legacy full-note response. Use `compact` for routine relevance checks: it returns 5 cards by default and rejects limits above 10. Each card contains identity, kind, scope, and relevance plus whitespace-normalized `summary` and `guidance`; each text field is capped at 240 Unicode code points (not UTF-16 units). Truncated fields end with `…` and include a truncation flag. The result also reports how many matches were available.

Start with compact search, judge relevance, and use `knowledge-get` for at most one exact named note when the bounded evidence is insufficient. Do not switch routinely to `full` merely to broaden context; `full` exists for compatibility and cases that genuinely require complete search results.

### How search works

1. **Full-text search** — tokenizes the query, strips special operators, searches title + content + tags + context
2. **Semantic embedding search** — if embeddings are enabled, generates a query vector and finds cosine-similar notes (races against a 500ms timeout)
3. **Reciprocal Rank Fusion** — merges both result sets into a single ranked list
4. **Domain note injection** — when a `project` filter is set and the project has a `domain` note, it is prepended to results regardless of relevance ranking. Configurable via `search.alwaysIncludeDomainNote` (default: `true`)
5. If the embedding model isn't ready (first query after startup), gracefully falls back to full-text-only

### Example

```json
{
  "query": "how do we handle authentication",
  "kind": "decision",
  "project": "my-app",
  "limit": 5
}
```

---

## knowledge-maintain

Maintain the knowledge base: view stats, review aging notes, find duplicates, promote/archive/delete notes, rebuild the index, and manage data migrations.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum | Yes | See actions table below |
| `noteId` | string | No | Note ID (required for `promote`, `archive`, `delete`; migration ID for `upgrade-read`) |
| `filter` | enum | No | For `review`: `fleeting` or `permanent` |
| `days` | number | No | Days threshold for `review` (default: from `lifecycle.reviewAfterDays` config) |
| `limit` | number | No | Max notes to show (default: 3 for `review`) |
| `dryRun` | boolean | No | Preview changes without applying |

### Actions

| Action | Description | Requires `noteId` |
|--------|-------------|-------------------|
| `review` | Surface notes that haven't been accessed recently for triage | No |
| `dedupe` | Read-only exact-title and SimHash audit over all active non-structural notes | No |
| `promote` | Move a fleeting note to permanent status | Yes |
| `archive` | Move a note to archived status | Yes |
| `delete` | Permanently delete a note (file + DB + FTS + links) | Yes |
| `rebuild` | Reconstruct the SQLite database from Markdown files on disk | No |
| `embed` | Backfill missing embedding vectors for existing notes | No |
| `agent-docs` | Audit or repair managed agent instruction files | No |
| `upgrade` | List pending data migrations | No |
| `upgrade-read` | Read a specific migration's instructions | Yes (migration ID) |
| `upgrade-apply` | Apply a data migration | Yes (migration ID) |
| `format` | Re-serialize all note files with canonical frontmatter and navigation | No |
| `scope-audit` | Detect incorrectly scoped client tags | No |
| `preference-audit` | Report deterministic quality signals in active personalization notes; read-only and non-mutating | No |
| `unlinked` | Find notes with no wikilinks | No |
| `broken-links` | Find wikilinks to non-existent notes | No |
| `link-health` | Combined report: unlinked + broken links + one-way links | No |
| `migrate-layout` | Move flat vault to kind-based directory structure | No |
| `upgrade-vault` | Refresh Obsidian scaffold assets | No |
| `project-authority-review` | Read-only, bounded evidence for active non-structural notes owned by one exact project | No |
| `full` | Composite: rebuild → migrate-layout → format → dedupe → embed → link-health (one-command maintenance) | No |

### Maintenance preview integrity

`dedupe` uses one stable snapshot of every active note except structural `index` and `log` notes. Existing valid hashes are reused; missing hashes are computed only in memory and are never written by the audit. Its coverage line reports `eligible`, `hashed-at-start`, `computed-ephemerally`, `evaluated`, `omitted`, and complete/incomplete status. Group totals remain complete; SimHash retains and displays only the first ten evidence groups, which include the threshold and distance-from-seed evidence. Findings are advisory; archive and delete remain explicit actions.

Lifecycle `review` candidates include whitespace-normalized summary and guidance evidence, each deterministically bounded to 240 characters. This evidence comes from the query-only review snapshot and does not increment access metadata.

`project-authority-review` requires `project`, defaults to 50 findings, and clamps its bound to 1–100. It returns deterministic ID-ordered identity, kind, bounded summary evidence, status, lifecycle, scope, and age, along with scanned/returned/truncated counts and `mutated: false`. It neither decides authority nor writes notes or destination systems.

Use its findings only to support a human or agent decision. Keep correctly placed knowledge; for misplaced or mixed notes, preserve the source, copy or distill accepted content with the destination's normal tools, verify the destination, and only then archive the KB source. Leave mixed or uncertain material active until every part is accounted for; defer when authority or verification is uncertain. Archive is reversible retirement, not deletion; deletion remains a separate explicit destructive action. The KB server does not write OpenSpec, docs, code/tests, Git, or issue trackers.

Deferred work includes lifecycle-rule precision, scoped contextual health, persisted baselines or suppressions, and scaling pairwise SimHash comparison.

### Examples

```json
{ "action": "full", "dryRun": true }
```

```json
{ "action": "review", "filter": "fleeting", "days": 14, "limit": 5 }
```

```json
{ "action": "promote", "noteId": "2026030919130100" }
```

```json
{ "action": "rebuild", "dryRun": true }
```

```json
{ "action": "preference-audit", "dryRun": true }
```

### Preference audit output

`preference-audit` scans non-archived personalization notes and reports deterministic matched evidence, including temporary wording, exact filesystem or client configuration paths, hex colors, model identifiers or routing language, configuration verbs, and missing applicability tags when scoped technology names appear. A clean scan reports that no preference quality signals were found.

The action is always read-only: it does not reclassify, archive, edit, or otherwise mutate notes. Its results are evidence for caller judgment, not instructions to take an action. Applicability remains represented by `project:*` and `client:*` tags; absence of both means universal.

---

## knowledge-health

Standalone tool for vault health metrics, staleness distribution, growth rates, and infrastructure status.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | Yes | Current project whose visible note metrics are requested |
| `client` | string | No | Client applicability filter for note counts, links, embeddings, staleness, and growth |
| `period` | string | No | Time window for growth rates: `"7d"`, `"30d"`, or `"90d"` (default: `"30d"`) |
| `telemetry` | boolean | No | Include 30-day local-only tool invocation aggregates |
| `model` | string | No | Your model identifier. Enables richer responses for capable models |

### What it returns

- **Health counts** — notes by status (fleeting, permanent, archived) and total
- **Embedding coverage** — how many notes have embeddings vs total
- **Link health summary** — broken links, unlinked notes, one-way links
- **Staleness distribution** — notes bucketed by days since last access
- **Growth rate by kind** — new notes per kind within the selected period
- **Infrastructure** — vault layout mode, Obsidian scaffold status, git status
- **Version** — current open-zk-kb version
- **Telemetry** (opt-in) — 30-day tool invocation aggregates when `telemetry: true`

### Example

```json
{ "project": "my-app", "client": "pi", "period": "7d", "telemetry": true }
```

---

## knowledge-context

Get retained context scoped to a required current project. Overview mode uses only notes whose project scope exactly matches the requested project; visible global notes do not count as matching project memory and are not shown as local inventory. It can be used for explicit orientation. When `client` is supplied, the shared project log is omitted because historical log entries do not carry enough scope metadata to filter safely.

The Pi extension requests the narrow `preferenceOnly` transport when a session starts. Automatic model context consists of the managed knowledge policy plus applicable retained preferences—not a compact project overview. The extension injects the preference capsule through the system prompt and displays a separate, deduplicated TUI entry; the model does not need to initiate a search. See the [Pi Experience](pi.md#automatic-project-preferences).

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project` | string | Yes | Current project whose visible context is requested |
| `logEntries` | number | No | Number of recent log entries to include (default: 10) |
| `includePreferences` | boolean | No | In overview mode, include a compact capsule of matching permanent personalization notes |
| `preferenceOnly` | boolean | No | Return only the preference capsule; used by Pi startup |
| `client` | string | No | Client identifier used to include matching client-scoped preferences |
| `model` | string | No | Your model identifier. Enables richer responses for capable models |

### Preference-only semantics

Preference-only mode considers only permanent personalization notes applicable to the exact project/client boundary. It returns at most 12 lines within an 800-token estimate (`ceil(UTF-16 code units / 4)`), skipping an oversized line so a later concise preference may fit. These lines are retained-memory claims and guidance, not project authority: verify requirements, status, and history in their owning systems. An empty capsule means no applicable retained preference was found; it does not mean that the project has no policy, requirements, or documentation.

### Project context

Overview mode returns a focused view of notes scoped to the exact required project. Global, prefix-related, subproject, and basename-collision scopes are not substituted as project-local context:

- **Domain note** — the project's domain note content (if one exists)
- **Inventory by kind** — note counts broken down by kind for the project
- **Recent notes** — recently created or accessed notes in the project
- **Resources** — resource notes scoped to the project
- **Activity log** — recent operations log entries (controlled by `logEntries`)

### Example

```json
{ "project": "my-app", "logEntries": 5 }
```
---

## knowledge-get

Retrieve a single note by its exact ID. Faster and more precise than knowledge-search. Use when you already know the note ID (e.g. from search results, context hints, or wikilink references).

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteId` | string | Yes | Exact note ID to retrieve |
| `project` | string | Yes | Current project used to validate note visibility |
| `client` | string | No | Optional client applicability filter |
| `model` | string | No | Your model identifier. Enables richer responses for capable models |

### What happens

1. Looks up the note by ID in the SQLite index
2. Returns the full note content in the same format as search results
3. Returns an error message if no note exists with the given ID

### When to use

- **Following references**: Search results and overview pages contain note IDs. Use `knowledge-get` to retrieve referenced notes without a full search.
- **After store**: The `knowledge-store` response includes the new note's ID. Use `knowledge-get` to verify or retrieve it later.
- **Compact rendering hints**: When `renderNoteForAgent` shows a truncated content preview with a hint, use `knowledge-get` with the note's ID to get the full content.

### Example

```json
{ "noteId": "2026030919130100", "project": "example-project", "client": "pi" }
```


## Project visibility and authority

Routine stored-knowledge tools (`knowledge-store`, `knowledge-search`, `knowledge-get`, `knowledge-context`, `knowledge-health`, and `knowledge-mine`) require an explicit current project. They can see that project's notes plus notes tagged `scope:global`, further restricted by compatible `client:*` tags. Notes belonging to other projects and unclassified notes are excluded before ranking, limiting, duplicate checks, links, counts, and exact-ID retrieval. Missing project context fails closed; there is no routine full-vault override. Ingest, template retrieval, and human-requested `knowledge-open` remain exceptions; Obsidian is a full-vault human browsing surface.

Routine storage and mining create only project-local notes with exactly one `project:*` tag. They cannot create `scope:global` notes. Global creation uses maintenance `publish-global`: the agent authors a complete project-agnostic candidate from a local source, previews scope/link/duplicate evidence and a confirmation token, shows that evidence to the user, then applies only after explicit confirmation. The source remains local and points one way to the new derivative; the global note contains no reverse project provenance. The server computes evidence; the agent judges it.

Maintenance actions—including review, dedupe, rebuild, format, embedding repair, audits, link health, migration, and publication—remain explicitly full-vault and label project ownership. Legacy notes with neither exactly one project tag nor `scope:global` are unclassified and invisible to routine calls. Use maintenance's legacy scope inventory and confirmed assignment to classify them; never silently treat them as global.
