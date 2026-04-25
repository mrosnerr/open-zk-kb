# Tools Reference

open-zk-kb exposes four MCP tools. Your AI assistant calls these automatically based on injected instructions — you rarely need to invoke them manually.

## knowledge-store

Store knowledge in the persistent knowledge base. One concept per note.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Note title — concise, descriptive |
| `content` | string | Yes | Note content — the knowledge to store |
| `kind` | enum | Yes | One of: `personalization`, `reference`, `decision`, `procedure`, `resource`, `observation` |
| `summary` | string | Yes | One-line present-tense key takeaway |
| `guidance` | string | Yes | Imperative actionable instruction for future agents |
| `status` | enum | No | Override default: `fleeting`, `permanent`, or `archived`. Defaults based on kind (see [Note Lifecycle](note-lifecycle.md)) |
| `tags` | string[] | No | Tags for categorization |
| `project` | string | No | Project scope — auto-adds `project:<name>` tag |
| `related` | string[] | No | IDs of related notes to link via `[[wikilinks]]` |

### What happens

1. Generates a timestamped ID (`YYYYMMDDHHmmss00`)
2. Creates a Markdown file with YAML frontmatter at `{vault}/{id}-{slug}.md`
3. Indexes the note in SQLite for full-text search
4. Generates a local embedding vector for semantic search (if enabled)
5. Checks for near-duplicates via SimHash and warns if found
6. Tracks wikilink relationships in the `note_links` table

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

## knowledge-ingest

Extract article content as clean markdown from a URL or pre-fetched HTML. Returns title, content, word count, and metadata. Deterministic — no LLM dependency.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | No* | URL to fetch and extract content from. Must be `http://` or `https://` |
| `html` | string | No* | Raw HTML to extract from. Use when you already fetched the page via another tool |

\* At least one of `url` or `html` must be provided. When both are provided, `html` is used for extraction and `url` is used for resolving relative links.

### What happens

1. **If `url` only** — fetches the page with SSRF protection (private IP blocking, redirect validation, streaming size limits), then extracts
2. **If `html` only** — extracts directly from provided HTML (no network request)
3. **If both** — extracts from `html`, uses `url` for relative link resolution
4. Extracts article content using Mozilla Readability (same engine as Firefox Reader View)
5. Converts to clean markdown (headings, lists, links preserved; images, iframes, nav stripped)
6. Returns structured metadata: title, word count, byline, excerpt, site name

### Usage patterns

**Direct URL ingestion** — when you have a URL and no other web tools:
```json
{ "url": "https://example.com/blog/article" }
```

**Pre-fetched HTML** — when you already got the page via Playwright, Exa, or another tool:
```json
{ "html": "<html><body><article>...</article></body></html>" }
```

**HTML with URL context** — for correct relative link resolution:
```json
{
  "url": "https://example.com/blog/article",
  "html": "<html>...</html>"
}
```

### Workflow

The intended workflow is a two-step pipeline:

1. `knowledge-ingest` → extract and review content
2. `knowledge-store` → save as a knowledge base note

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
| `project` | string | No | Filter by project tag |
| `tags` | string[] | No | Filter by tags (all must match) |
| `limit` | number | No | Max results (default 10) |

### How search works

1. **Full-text search** — tokenizes the query, strips special operators, searches title + content + tags + context
2. **Semantic embedding search** — if embeddings are enabled, generates a query vector and finds cosine-similar notes (races against a 500ms timeout)
3. **Reciprocal Rank Fusion** — merges both result sets into a single ranked list
4. If the embedding model isn't ready (first query after startup), gracefully falls back to full-text-only

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
| `stats` | Vault statistics: note counts by status, total, age breakdown | No |
| `review` | Surface notes that haven't been accessed recently for triage | No |
| `dedupe` | Find near-duplicate notes using SimHash similarity | No |
| `promote` | Move a fleeting note to permanent status | Yes |
| `archive` | Move a note to archived status | Yes |
| `delete` | Permanently delete a note (file + DB + FTS + links) | Yes |
| `rebuild` | Reconstruct the SQLite database from Markdown files on disk | No |
| `embed` | Backfill missing embedding vectors for existing notes | No |
| `agent-docs` | Audit or repair managed agent instruction files | No |
| `upgrade` | List pending data migrations | No |
| `upgrade-read` | Read a specific migration's instructions | Yes (migration ID) |
| `upgrade-apply` | Apply a data migration | Yes (migration ID) |

### Examples

```json
{ "action": "stats" }
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
