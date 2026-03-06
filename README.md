# open-zk-kb

[![CI](https://github.com/mrosnerr/open-zk-kb/actions/workflows/ci.yml/badge.svg)](https://github.com/mrosnerr/open-zk-kb/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/open-zk-kb)](https://www.npmjs.com/package/open-zk-kb)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Persistent knowledge base for AI coding assistants. Stores decisions, preferences, patterns, and context as Markdown notes indexed with SQLite FTS5 — so your assistant remembers across sessions.

## Modes of Operation

1. **MCP Server**
   Works with any MCP-compatible client (Claude Code, Cursor, Windsurf, Zed). No configuration is required for basic use.

2. **OpenCode Plugin**
   Enhanced features including auto-capture via pattern detection, LLM quality gate, and 2-layer context injection. Requires a `config.yaml` file with an API provider.

## Quick Start

```bash
bunx open-zk-kb
```

The interactive installer lets you select which clients to set up (OpenCode, Claude Code, Cursor, Windsurf, Zed).

## Manual Install

If you prefer manual configuration, add open-zk-kb to your client's MCP config file. No cloning required — the npm package includes everything.

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

### Zed

`~/.config/zed/settings.json`

```json
{
  "context_servers": {
    "open-zk-kb": {
      "command": "bunx",
      "args": ["open-zk-kb-server"]
    }
  }
}
```

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

## Configuration

All settings live in a single file: `~/.config/open-zk-kb/config.yaml`

- **Top-level keys** (vault, logLevel, grooming) apply to both modes.
- **`opencode:` section** enables advanced plugin features (auto-capture, embeddings, injection).

No configuration is required for basic MCP server usage. For a full reference, see [docs/configuration.md](docs/configuration.md).

## Storage

Knowledge is stored as Markdown files with YAML frontmatter. A SQLite FTS5 index provides fast searching. The filesystem remains the source of truth; the database can be reconstructed from files using `knowledge-maintain rebuild`.

## Requirements

- [Bun](https://bun.sh) >= 1.0.0 (required — uses `bun:sqlite` for storage)

## Links

- [Setup Guide](docs/setup-guide.md)
- [Configuration Reference](docs/configuration.md)
- [Architecture Design](docs/architecture.md)
- [Development & Contributing](docs/development.md)
- [Contributing Guidelines](CONTRIBUTING.md)

## License

[MIT License](LICENSE)
