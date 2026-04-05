# open-zk-kb

Persistent AI memory across sessions. Search context before work, store preferences, decisions, and observations automatically.

## What It Does

open-zk-kb gives Claude Code a persistent knowledge base that survives across sessions. Instead of re-explaining your preferences, project decisions, or learned patterns every time, Claude remembers.

**Example uses:**
- "Remember I prefer Bun over Node.js" → stored, applied in future sessions
- "We decided to use FTS5 for search because..." → decision preserved
- Hit a weird error? → observation saved so you don't debug it twice

## Prerequisites

This plugin includes pre-compiled binaries for all platforms. No runtime dependencies required.

**Supported platforms:**
- macOS (Apple Silicon & Intel)
- Linux (x64 & ARM64)
- Windows (x64)

## Installation

### From Official Marketplace

```text
/plugin install open-zk-kb@claude-plugins-official
```

### From GitHub

```text
/plugin install github:mrosnerr/open-zk-kb/plugin
```

### Local Development

```bash
claude --plugin-dir /path/to/open-zk-kb/plugin
```

## Available Tools

| Tool | Description |
|------|-------------|
| `knowledge-search` | Search the knowledge base using full-text search and semantic similarity |
| `knowledge-store` | Store a note with title, content, kind, summary, and guidance |
| `knowledge-maintain` | Maintenance actions: stats, review, dedupe, promote, archive, delete |

## Note Kinds

| Kind | When to Store |
|------|---------------|
| **personalization** | User says "I prefer", "always", "never", or corrects you |
| **decision** | You and user weigh options and pick one |
| **observation** | You hit a non-obvious error or gotcha |
| **reference** | You look something up twice in one session |
| **procedure** | You discover a multi-step workflow by doing it |
| **resource** | A useful URL comes up |

## Data Storage

Notes are stored locally in `~/.local/share/open-zk-kb/` as Markdown files with YAML frontmatter. SQLite with FTS5 provides fast full-text search. Optional local embeddings (MiniLM-L6-v2) enable semantic search.

## Configuration

Optional config at `~/.config/open-zk-kb/config.yaml`:

```yaml
vault: ~/.local/share/open-zk-kb  # Note storage location
logLevel: INFO                     # DEBUG, INFO, WARN, ERROR

embeddings:
  enabled: true                    # Enable semantic search
  provider: local                  # local (default) or api
```

## Documentation

- [Full Documentation](https://mrosnerr.github.io/open-zk-kb)
- [GitHub Repository](https://github.com/mrosnerr/open-zk-kb)

## License

MIT
