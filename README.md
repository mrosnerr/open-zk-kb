# open-zk-kb

[![CI](https://github.com/mrosnerr/open-zk-kb/actions/workflows/ci.yml/badge.svg)](https://github.com/mrosnerr/open-zk-kb/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/open-zk-kb)](https://www.npmjs.com/package/open-zk-kb)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Persistent knowledge base for AI coding assistants. Stores decisions, preferences, patterns, and context as Markdown notes indexed with SQLite FTS5 — so your assistant remembers across sessions.

> **Beta** — This project is under active development (`0.1.x`). Core functionality works but APIs may change. [Bug reports](https://github.com/mrosnerr/open-zk-kb/issues) and feedback are welcome.

*Store decisions, search knowledge, and maintain context — across every session.*

<details>
<summary>Demo</summary>
<br>
<img src="assets/demo.gif" alt="Demo" width="600">

</details>

## Quick Start

> **Requires [Bun](https://bun.sh)** — install with `curl -fsSL https://bun.sh/install | bash`

```bash
bunx open-zk-kb
```

The interactive installer lets you select which clients to set up (OpenCode, Claude Code, Cursor, Windsurf). Knowledge capture is driven by `AGENTS.md` or `CLAUDE.md` instructions provided during setup.

## Manual Install

If you prefer manual configuration, add open-zk-kb to your client's MCP config file. No cloning required — the npm package includes everything.

### OpenCode

`~/.config/opencode/opencode.json`

```json
{
  "mcp": {
    "open-zk-kb": {
      "type": "local",
      "command": ["bunx", "open-zk-kb-server"],
      "enabled": true
    }
  }
}
```

### Claude Code

`~/.claude/settings.json`

```json
{
  "mcpServers": {
    "open-zk-kb": {
      "command": "bunx",
      "args": ["open-zk-kb-server"]
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "open-zk-kb": {
      "command": "bunx",
      "args": ["open-zk-kb-server"]
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "open-zk-kb": {
      "command": "bunx",
      "args": ["open-zk-kb-server"]
    }
  }
}
```

## Development

### From source

```bash
git clone https://github.com/mrosnerr/open-zk-kb
cd open-zk-kb
bun install && bun run build
bun run setup            # interactive installer
```

## Tools

| Tool | Description |
|------|-------------|
| `knowledge-store` | Create or update a knowledge note with metadata. |
| `knowledge-search` | Full-text search across the entire knowledge base. |
| `knowledge-maintain` | Manage the knowledge base: stats, review, promote, archive, or rebuild. |

## Note Kinds

| Kind | Default Status | Use Case |
|------|----------------|----------|
| `personalization` | permanent | User preferences, habits, and personal style. |
| `reference` | fleeting | Technical facts, API details, and documentation snippets. |
| `decision` | permanent | Architectural choices, project commitments, and trade-offs. |
| `procedure` | fleeting | Step-by-step workflows and recurring tasks. |
| `resource` | permanent | Links, tools, libraries, and external documentation. |
| `observation` | fleeting | Insights, patterns, and temporary findings. |

## Note Lifecycle

Notes follow a progression to maintain relevance:
**fleeting** → **permanent** → **archived**

For details on the review system, promotion, and archiving, see [Note Lifecycle](docs/note-lifecycle.md).

## Configuration

All settings live in a single file: `~/.config/open-zk-kb/config.yaml` — the installer creates this automatically.

No configuration is required for basic usage. Local embeddings (MiniLM, 23MB) are enabled by default and require no API key. To use an API provider for embeddings:

```yaml
vault: "~/.local/share/open-zk-kb"
logLevel: "info"

embeddings:
  provider: "api"
  base_url: "https://openrouter.ai/api/v1"
  api_key: "your-api-key-here"
  model: "openai/text-embedding-3-small"
  dimensions: 1536
```

Any OpenAI-compatible API works (OpenRouter, Together, Groq, local vLLM, etc.). For the full reference, see [docs/configuration.md](docs/configuration.md).

## Storage

Knowledge is stored as Markdown files with YAML frontmatter. A SQLite FTS5 index provides fast searching, with vector embeddings generated locally by default via `@huggingface/transformers` (MiniLM-L6-v2, ~23MB). The filesystem remains the source of truth; the database can be reconstructed from files using `knowledge-maintain rebuild`.

## Requirements

- [Bun](https://bun.sh) >= 1.0.0 (required — uses `bun:sqlite` for storage)

## Links

- [Setup Guide](docs/setup-guide.md)
- [Configuration Reference](docs/configuration.md)
- [Note Lifecycle](docs/note-lifecycle.md)
- [Architecture Design](docs/architecture.md)
- [Development & Contributing](docs/development.md)
- [Contributing Guidelines](CONTRIBUTING.md)

## License

[MIT License](LICENSE)
