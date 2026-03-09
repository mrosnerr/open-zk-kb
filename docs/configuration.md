# Configuration Reference

## Overview

open-zk-kb uses a single YAML configuration file:

**Location**: `~/.config/open-zk-kb/config.yaml`

The file contains core settings for the MCP server, including vault location, log level, note lifecycle, and vector embeddings.

For a detailed explanation of note statuses, kinds, and the review system, see [Note Lifecycle](note-lifecycle.md).

No configuration is required for basic usage — sensible defaults apply.

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

## Environment & Paths

| Path | Default | Purpose |
|------|---------|---------|
| Vault (notes) | ~/.local/share/open-zk-kb/ | Note files + SQLite DB |
| Config | ~/.config/open-zk-kb/config.yaml | All settings |
| Logs | ~/.local/state/open-zk-kb/logs/ | File-based logs |

All paths follow XDG Base Directory Specification. Override with XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME.
