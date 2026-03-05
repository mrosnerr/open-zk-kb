# Changelog

## 1.0.0

Initial release.

### Features

- **MCP Server**: Works with any MCP-compatible client (Claude Code, Cursor, Windsurf, Zed)
- **OpenCode Plugin**: Auto-capture via pattern detection, LLM quality gate, 2-layer context injection
- **Three tools**: `knowledge-store`, `knowledge-search`, `knowledge-maintain`
- **Six note kinds**: personalization, reference, decision, procedure, resource, observation
- **Note lifecycle**: fleeting → permanent → archived
- **Dual storage**: Markdown files (source of truth) + SQLite FTS5 index
- **Wiki-links**: Obsidian-compatible `[[slug|display]]` format with backlink tracking
- **Vector search**: Optional embedding support via OpenAI-compatible API
- **CLI installer**: `bun run setup install --client <name>` for 5 clients
- **Data migrations**: Agent-driven `upgrade` action for schema evolution
