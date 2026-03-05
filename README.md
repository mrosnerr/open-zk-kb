# open-zk-kb

Persistent knowledge base for AI coding assistants. Stores decisions, preferences, patterns, and context as Markdown notes indexed with SQLite FTS5 — so your assistant remembers across sessions.

## Modes of Operation

1. **MCP Server**
   Works with any MCP-compatible client (Claude Code, Cursor, Windsurf, Zed). No configuration is required for basic use.

2. **OpenCode Plugin**
   Enhanced features including auto-capture via pattern detection, LLM quality gate, and 2-layer context injection. Requires a `config.yaml` file with an API provider.

## Quick Start

1. Clone and build:
   ```bash
   git clone https://github.com/open-zk-kb/open-zk-kb
   cd open-zk-kb
   bun install && bun run build
   ```

2. Install for your client:

   **MCP Track**
   ```bash
   bun run setup install --client claude-code
   ```
   Supported clients: `claude-code`, `cursor`, `windsurf`, `zed`.

   **OpenCode Track**
   ```bash
   bun run setup install --client opencode
   mkdir -p ~/.config/open-zk-kb
   cp config.example.yaml ~/.config/open-zk-kb/config.yaml
   ```
   Edit `~/.config/open-zk-kb/config.yaml` to set your API provider and model for the quality gate.

## Manual Install

For MCP clients, add the following to your configuration file:

```json
{
  "open-zk-kb": {
    "type": "local",
    "command": ["bun", "run", "/path/to/open-zk-kb/dist/mcp-server.js"],
    "enabled": true
  }
}
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

- Bun >= 1.0.0 (Not compatible with Node.js)

## Links

- [Setup Guide](docs/setup-guide.md)
- [Configuration Reference](docs/configuration.md)
- [Architecture Design](docs/architecture.md)
- [Development & Contributing](docs/development.md)
- [Contributing Guidelines](CONTRIBUTING.md)

## License

[MIT License](LICENSE)
