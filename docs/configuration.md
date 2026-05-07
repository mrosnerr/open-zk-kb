# Configuration Reference

## Overview

open-zk-kb uses a single YAML configuration file:

**Location**: `~/.config/open-zk-kb/config.yaml`

The file contains core settings for the MCP server, including vault location, log level, note lifecycle, the Obsidian vault scaffold, and vector embeddings.

For a detailed explanation of note statuses, kinds, and the review system, see [Note Lifecycle](note-lifecycle.md).

No configuration is required for basic usage — sensible defaults apply. For installation, see the [Setup Guide](setup-guide.md). For tool usage, see the [Tools Reference](tools-reference.md).

## Core Settings

```yaml
vault: ~/.local/share/open-zk-kb
logLevel: INFO
lifecycle:
  reviewAfterDays: 14
  promotionThreshold: 2
  exemptKinds:
    - personalization
    - decision
embeddings:
  enabled: true
  provider: local
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| vault | string | ~/.local/share/open-zk-kb | Directory where notes and DB are stored |
| logLevel | string | INFO | Log verbosity: DEBUG, INFO, WARN, ERROR |
| lifecycle.reviewAfterDays | number | 14 | Days until a note is surfaced for review |
| lifecycle.promotionThreshold | number | 2 | Accesses needed to recommend promotion to permanent |
| lifecycle.exemptKinds | string[] | ["personalization", "decision"] | Note kinds exempt from the review queue |
| telemetry.enabled | boolean | false | Enable local-only tool invocation counters and access timestamps (opt-in) |
| obsidian.scaffold | boolean | true | Create and maintain the opinionated `.obsidian/` scaffold used by `knowledge-open` |
| obsidian.autoUpgrade | boolean | true | Refresh pinned theme/plugin/snippet assets when the server starts |
| obsidian.readOnly | boolean | true | Default Obsidian to Reading View and enable read-only helpers |
| embeddings.enabled | boolean | true | Enable vector embeddings |
| embeddings.provider | string | local | Embedding provider: local or api |
| embeddings.model | string | all-MiniLM-L6-v2 | Embedding model (local or API) |
| embeddings.dimensions | number | 384 | Embedding dimensions (must match model) |
| embeddings.base_url | string | (optional) | Base URL for OpenAI-compatible API |
| embeddings.api_key | string | (optional) | API key for the provider |

## Embeddings (Local-First)

Embeddings work **out of the box** with zero configuration using a local model (`all-MiniLM-L6-v2`, 384 dimensions).
- ~23MB model downloaded on first use, cached in `~/.cache/open-zk-kb/models/`
- To override with an API provider (for higher-quality embeddings), configure the `embeddings` section with `provider: api`.
- To disable embeddings entirely, set `enabled: false`.

## Telemetry (Local-Only, Opt-In)

Telemetry is **disabled by default** and must be explicitly opted into. When enabled, it is stored only in the local SQLite database under the vault — nothing is ever sent remotely. It records coarse tool invocation counters for `knowledge-maintain stats` when called with `telemetry: true`.

```yaml
telemetry:
  enabled: true
```

When disabled (the default), open-zk-kb records no telemetry rows and also skips note access tracking (`last_accessed_at` and `access_count`). This treats access timestamps as privacy-sensitive metadata and makes the default posture maximally private.

Recorded fields:
- Synthetic per-connection session ID
- Tool name (`search`, `store`, `maintain`)
- Store kind or maintain action
- Timestamp
- Result count for searches and successful stores

Not recorded:
- Note content
- Note bodies
- Search query strings
- Search result snippets
- File paths
- User identifiers, client identifiers, hostnames, or account names
- API keys, tokens, credentials, or other secrets

## Obsidian Vault Scaffold

[`knowledge-open`](tools-reference.md#knowledge-open) scaffolds a polished Obsidian vault experience on first launch. See the [Obsidian Guide](obsidian.md) for the full walkthrough.

- Minimal theme
- Community plugin bundle (Breadcrumbs, Homepage, QuickAdd, Commander, Templater, Minimal Settings, OZ Calendar, Read Only View)
- CSS snippets for dashboard layout, better tables, hidden metadata, and optional read-only controls
- Auto-copied note templates under `templates/`
- Versioned scaffold manifest at `.obsidian/open-zk-kb.json`

The scaffold is the primary presentation layer for humans using the vault in Obsidian. Over time, generated `index` and `log` notes may use more Obsidian-native functionality from the managed plugin bundle. Core knowledge notes remain markdown-native and continue to be indexed by the MCP server without depending on plugin-specific syntax.

```yaml
obsidian:
  scaffold: true
  autoUpgrade: true
  readOnly: true
```

### `obsidian.scaffold`

- `true` (default): create or merge the managed `.obsidian/` scaffold when needed
- `false`: skip scaffold creation entirely

### `obsidian.autoUpgrade`

- `true` (default): when `.obsidian/open-zk-kb.json` exists, the server refreshes pinned theme/plugin assets on startup
- `false`: leave existing scaffold assets untouched until `knowledge-maintain` action `upgrade-vault`

### `obsidian.readOnly`

- `true` (default): sets Obsidian to Reading View, enables the read-only CSS snippet, and installs the `read-only-view` plugin config
- `false`: keeps the rest of the scaffold, but omits the read-only helpers and defaults new tabs to source mode

## Example Configurations

### a) Minimal
No configuration file required. Install and use with default settings.

### b) Custom vault path only
```yaml
vault: ~/my-knowledge-base
```

### c) API Embeddings (Override)
```yaml
embeddings:
  provider: api
  base_url: https://openrouter.ai/api/v1
  api_key: "your-api-key-here"
  model: openai/text-embedding-3-small
  dimensions: 1536
```

### d) Embeddings disabled
```yaml
embeddings:
  enabled: false
```

### e) Telemetry disabled
```yaml
telemetry:
  enabled: false
```

### f) Editable Obsidian vault
```yaml
obsidian:
  readOnly: false
```

## Environment & Paths

| Path | Default | Purpose |
|------|---------|---------|
| Vault (notes) | ~/.local/share/open-zk-kb/ | Note files + SQLite DB |
| Config | ~/.config/open-zk-kb/config.yaml | All settings |
| Logs | ~/.local/state/open-zk-kb/logs/ | File-based logs |

All paths follow XDG Base Directory Specification. Override with XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME.
