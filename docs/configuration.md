# Configuration Reference

## Overview

open-zk-kb uses a single YAML configuration file:

**Location**: `~/.config/open-zk-kb/config.yaml`

The file contains core settings for the MCP server, including vault location, log level, note lifecycle, the Obsidian vault scaffold, vector embeddings, and shared HTTP server configuration.

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
| telemetry.enabled | boolean | false | Enable local-only tool invocation counters and access timestamps |
| telemetry.share | boolean | false | Share anonymous session analytics when local telemetry is also enabled |
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

## Telemetry

Telemetry has two layers. Both runtime configuration defaults are `false`; during interactive installation, the consent prompt has **Yes** preselected and writes both settings as `true` only after confirmation. Choosing No, cancelling, using `--no-telemetry`, or installing non-interactively leaves the runtime defaults unchanged.

**Local counters** (`telemetry.enabled`) — Records tool invocation counters and note access timestamps to the local SQLite database. Never leaves your machine. Used by `knowledge-health` for usage breakdowns.

**Anonymous sharing** (`telemetry.share`) — When also enabled, anonymous session metadata (client, models, version, platform, vault size, tool usage counts) is sent to PostHog (EU Cloud) on the next server startup. No note content, search queries, file paths, names, or email addresses are shared. See [Telemetry](telemetry.md) for the full event schema.

```yaml
telemetry:
  enabled: true    # local counters only
  share: true      # also send anonymous session data to PostHog
```

When disabled, open-zk-kb records no telemetry rows, skips note access tracking (`last_accessed_at` and `access_count`), and sends nothing externally.

## Obsidian Vault Scaffold

[`knowledge-open`](tools-reference.md) scaffolds a polished Obsidian vault experience on first launch. See the [Obsidian Guide](obsidian.md) for the full walkthrough.

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

## Server

Settings for the shared HTTP server mode (`open-zk-kb serve`).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `server.port` | integer | `17244` | Port for the HTTP server |
| `server.host` | string | `127.0.0.1` | Bind address (localhost recommended for security) |

Example:

```yaml
server:
  port: 18000
  host: 127.0.0.1
```

See [Setup Guide: Shared Server Mode](setup-guide.md#shared-server-mode-multi-session) for usage instructions.

## Environment & Paths

| Path | Default | Purpose |
|------|---------|---------|
| Vault (notes) | ~/.local/share/open-zk-kb/ | Note files + SQLite DB |
| Config | ~/.config/open-zk-kb/config.yaml | All settings |
| Logs | ~/.local/state/open-zk-kb/logs/ | File-based logs |

All paths follow XDG Base Directory Specification. Override with XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME.
