# Changelog

## 0.1.0-beta.3

- Fix npm trusted publishing (requires npm >= 11.5.1 for OIDC token exchange)
- Bun runtime guards on MCP server and installer
- Installer writes `bunx` commands for npm installs
- Dev → main branch workflow with auto-publish

## 0.1.0-beta.2

(Failed publish — provenance signed but npm OIDC exchange required npm >= 11.5.1)

## 0.1.0-beta.1

Initial beta release.

### Features

- **MCP Server**: Works with any MCP-compatible client (Claude Code, Cursor, Windsurf, Zed)
- **OpenCode Plugin**: Auto-capture via pattern detection, LLM quality gate, 2-layer context injection
- **Three tools**: `knowledge-store`, `knowledge-search`, `knowledge-maintain`
- **Six note kinds**: personalization, reference, decision, procedure, resource, observation
- **Note lifecycle**: fleeting → permanent → archived
- **Dual storage**: Markdown files (source of truth) + SQLite FTS5 index
- **Wiki-links**: Obsidian-compatible `[[slug|display]]` format with backlink tracking
- **Vector search**: Optional embedding support via OpenAI-compatible API
- **CLI installer**: `bunx open-zk-kb` (npm) or `bun run setup` (source) for 5 clients
- **Data migrations**: Agent-driven `upgrade` action for schema evolution
