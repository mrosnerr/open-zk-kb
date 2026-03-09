# open-zk-kb

[![CI](https://github.com/mrosnerr/open-zk-kb/actions/workflows/ci.yml/badge.svg)](https://github.com/mrosnerr/open-zk-kb/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/open-zk-kb)](https://www.npmjs.com/package/open-zk-kb)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Persistent knowledge base for AI coding assistants. Stores decisions, preferences, patterns, and context as Markdown notes indexed with SQLite FTS5 — so your assistant remembers across sessions.

> **Beta** — This project is under active development (`0.1.x`). Core functionality works but APIs may change. [Bug reports](https://github.com/mrosnerr/open-zk-kb/issues) and feedback are welcome.

<details>
<summary>Demo</summary>
<br>
<img src="assets/demo.gif" alt="Demo" width="600">

> The GIF shows the installer and a scripted API harness exercising all three MCP tools. In real usage, your AI assistant calls the tools automatically based on the injected AGENTS.md instructions — no manual tool calls needed.

</details>

## Quick Start

> **Requires [Bun](https://bun.sh)** — install with `curl -fsSL https://bun.sh/install | bash`

```bash
bunx open-zk-kb
```

That's it. The interactive installer:
1. Adds the MCP server to your client config
2. Injects knowledge base instructions into your client's instruction file (`AGENTS.md`, `CLAUDE.md`, or rules file)
3. Creates a local vault at `~/.local/share/open-zk-kb`

Supported clients: **OpenCode**, **Claude Code**, **Cursor**, **Windsurf**

## How It Works

Your AI assistant gets three MCP tools:

| Tool | What it does |
|------|-------------|
| `knowledge-search` | Search the knowledge base before starting work |
| `knowledge-store` | Save decisions, preferences, procedures, and insights |
| `knowledge-maintain` | Review, promote, archive, and rebuild notes |

The installer injects instructions that guide the AI to **proactively search** for relevant context before starting work and **store valuable knowledge** as it discovers it. No plugin required — the AI drives everything through tool calls.

Notes are stored as Markdown files with YAML frontmatter. A SQLite FTS5 index provides fast full-text search, with local vector embeddings (MiniLM, 23MB) for semantic matching. No API key needed.

## Configuration

Zero configuration required for basic usage. The installer creates `~/.config/open-zk-kb/config.yaml` automatically.

To use an API provider for embeddings instead of local models:

```yaml
embeddings:
  provider: "api"
  base_url: "https://openrouter.ai/api/v1"
  api_key: "your-api-key-here"
  model: "openai/text-embedding-3-small"
  dimensions: 1536
```

Any OpenAI-compatible API works (OpenRouter, Together, Groq, local vLLM, etc.). See [docs/configuration.md](docs/configuration.md) for the full reference.

<details>
<summary><h2>Manual Install</h2></summary>

If you prefer manual configuration, add open-zk-kb to your client's MCP config file. No cloning required — the npm package includes everything.

> **Note**: Manual install only adds the MCP server. To also inject the agent instructions, run `bunx open-zk-kb install --client <name>` or add the contents of `agent-instructions.md` to your client's instruction file.

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

</details>

<details>
<summary><h2>Note Kinds</h2></summary>

| Kind | Default Status | Use Case |
|------|----------------|----------|
| `personalization` | permanent | User preferences, habits, and personal style |
| `reference` | fleeting | Technical facts, API details, and documentation snippets |
| `decision` | permanent | Architectural choices, project commitments, and trade-offs |
| `procedure` | fleeting | Step-by-step workflows and recurring tasks |
| `resource` | permanent | Links, tools, libraries, and external documentation |
| `observation` | fleeting | Insights, patterns, and temporary findings |

Notes follow a lifecycle: **fleeting** → **permanent** → **archived**. See [Note Lifecycle](docs/note-lifecycle.md) for details.

</details>

## Development

```bash
git clone https://github.com/mrosnerr/open-zk-kb
cd open-zk-kb
bun install && bun run build
bun run setup            # interactive installer
```

## Links

- [Setup Guide](docs/setup-guide.md) — installation, instruction injection, verification
- [Configuration Reference](docs/configuration.md) — embeddings, vault, logging
- [Note Lifecycle](docs/note-lifecycle.md) — statuses, review, promotion
- [Architecture Design](docs/architecture.md) — system design, dual storage, instruction injection
- [Development & Contributing](docs/development.md) — local dev, testing, debugging
- [Contributing Guidelines](CONTRIBUTING.md)

## License

[MIT License](LICENSE)
