# Configuration Reference

## Overview

open-zk-kb uses a single YAML configuration file:

**Location**: `~/.config/open-zk-kb/config.yaml`

The file has two sections:
1. **Top-level keys** (vault, logLevel, grooming): Core settings used by both MCP Server and OpenCode Plugin.
2. **`opencode:` section**: Advanced features for the OpenCode plugin (auto-capture, quality gate, embeddings, context injection).

No configuration is required for basic MCP server usage — sensible defaults apply.

## Section 1: Core Settings

These apply to both the MCP Server and OpenCode Plugin.

```yaml
vault: ~/.local/share/open-zk-kb
logLevel: INFO
grooming:
  stalenessDays: 14
  minAccessCount: 2
  protectedKinds:
    - personalization
    - decision
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| vault | string | ~/.local/share/open-zk-kb | Directory where notes and DB are stored |
| logLevel | string | INFO | Log verbosity: DEBUG, INFO, WARN, ERROR |
| grooming.stalenessDays | number | 14 | Days until a note is flagged for review |
| grooming.minAccessCount | number | 2 | Access threshold — notes below this + stale days are flagged |
| grooming.protectedKinds | string[] | ["personalization", "decision"] | Note kinds exempt from staleness |

## Section 2: OpenCode Plugin Settings

Nested under the `opencode:` key. Required for OpenCode plugin features (auto-capture, embeddings, context injection).

```yaml
opencode:
  provider:
    base_url: https://openrouter.ai/api/v1
    api_key: "your-api-key-here"

  capture:
    auto: true
    model: anthropic/claude-haiku-4-5
    threshold: 7
    max_calls_per_session: 20

  embeddings:
    enabled: true
    model: openai/text-embedding-3-small
    dimensions: 1536

  injection:
    enabled: true
    max_notes: 10
    context_aware: false
    inject_capture_status: false

  excluded_apps: []
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| opencode.provider.base_url | string | (required) | Base URL for OpenAI-compatible API |
| opencode.provider.api_key | string | (required) | API key for the provider |
| opencode.capture.auto | boolean | true | Enable auto-capture via pattern detection |
| opencode.capture.model | string | anthropic/claude-haiku-4-5 | Model for quality gate evaluation |
| opencode.capture.threshold | number | 7 | Minimum score (1-10) for auto-capture |
| opencode.capture.max_calls_per_session | number | 20 | Max quality gate calls per session |
| opencode.capture.base_url | string | inherits from provider | Override API URL for capture |
| opencode.capture.api_key | string | inherits from provider | Override API key for capture |
| opencode.embeddings.enabled | boolean | true | Enable vector embeddings |
| opencode.embeddings.model | string | openai/text-embedding-3-small | Embedding model |
| opencode.embeddings.dimensions | number | 1536 | Embedding dimensions (must match model) |
| opencode.embeddings.base_url | string | inherits from provider | Override API URL for embeddings |
| opencode.embeddings.api_key | string | inherits from provider | Override API key for embeddings |
| opencode.injection.enabled | boolean | true | Enable knowledge injection into prompts |
| opencode.injection.max_notes | number | 10 | Maximum notes injected per turn |
| opencode.injection.context_aware | boolean | false | Enable query-based note selection (Layer 2) |
| opencode.injection.inject_capture_status | boolean | false | Show capture activity in system prompt |
| opencode.excluded_apps | string[] | [] | App names to exclude from capture |

## Section 3: Example Configurations

### a) Minimal (MCP server only)
No configuration file required. Install and use with default settings.

### b) Custom vault path only
```yaml
vault: ~/my-knowledge-base
```

### c) OpenCode with OpenRouter
```yaml
opencode:
  provider:
    base_url: https://openrouter.ai/api/v1
    api_key: "your-api-key-here"
  capture:
    auto: true
    model: anthropic/claude-haiku-4-5
  embeddings:
    enabled: true
    model: openai/text-embedding-3-small
    dimensions: 1536
```

### d) OpenCode with local LLM
```yaml
opencode:
  provider:
    base_url: http://localhost:11434/v1
    api_key: "ollama"
  capture:
    auto: true
    model: llama3
  embeddings:
    enabled: false
```

## Section 4: Environment & Paths

| Path | Default | Purpose |
|------|---------|---------|
| Vault (notes) | ~/.local/share/open-zk-kb/ | Note files + SQLite DB |
| Config | ~/.config/open-zk-kb/config.yaml | All settings |
| Logs | ~/.local/state/open-zk-kb/logs/ | File-based logs |

All paths follow XDG Base Directory Specification. Override with XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME.
