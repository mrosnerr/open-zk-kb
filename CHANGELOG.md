# Changelog

## 0.1.0-beta.8

- **Revamp demo** — curated cooking-metaphor Q&A, no more local generation model dependency
- **Move demo workflow to dev** — GIF generated on push to dev, flows to main via release PR
- **Remove generation model from CI** — drop Qwen2.5-1.5B from smoke tests and cache, faster CI
- **Demo header + attribution** — added ## Demo section and subtext in README

## 0.1.0-beta.7

- Fix doctor indentation and document cache-busting import pattern
- **Launch readiness** — add doctor command with `--fix`, beta checklist, Zed docs
- **Workflow reliability** — fix CI workflows, unblock ESLint 10
- Bump actions/upload-pages-artifact from 3 to 4
- Bump actions/github-script from 7 to 8
- Bump actions/cache from 4 to 5

## 0.1.0-beta.5

- **Remove OpenCode plugin** — knowledge capture now fully agent-driven via MCP tools + injected AGENTS.md/CLAUDE.md instructions
- **Local embeddings default** — `@huggingface/transformers` MiniLM-L6-v2 (~23MB, no API key required); optional API override
- **Instruction injection** — installer auto-injects KB instructions into client global instruction files; upgrade-safe marker-based system
- **Restore Zed client** — 5 supported clients: OpenCode, Claude Code, Cursor, Windsurf, Zed
- **Non-blocking search** — embedding generation races against 500ms timeout; full-text fallback if model not warmed up
- **Embedding warm-up** — model loads at server startup so first search gets semantic results
- **Tags filter** — `knowledge-search` now accepts `tags` parameter for filtering
- **Schema v5** — drops `capture_metrics` table, adds `content_hash` column for SimHash deduplication
- **Rename `PluginConfig` → `AppConfig`** — internal cleanup
- **Portable path resolution** — `fileURLToPath` instead of `new URL().pathname` in installer
- **ASCII-only instruction markers** — removed em-dash from managed block markers

## 0.1.0-beta.4

- Fix npm trusted publishing (requires npm >= 11.5.1 for OIDC token exchange)
- Fix prerelease publish requiring `--tag beta` on npm latest
- Bun runtime guards on MCP server and installer
- Installer writes `bunx` commands for npm installs
- Dev → main branch workflow with auto-publish

## 0.1.0-beta.2 / beta.3

(Failed publishes — OIDC token exchange required npm >= 11.5.1, prerelease required --tag)

## 0.1.0-beta.1

Initial beta release.

### Features

- **MCP Server**: Works with any MCP-compatible client (Claude Code, Cursor, Windsurf)
- **OpenCode Plugin** (removed in beta.2): Auto-capture via pattern detection, LLM quality gate, 2-layer context injection
- **Three tools**: `knowledge-store`, `knowledge-search`, `knowledge-maintain`
- **Six note kinds**: personalization, reference, decision, procedure, resource, observation
- **Note lifecycle**: fleeting → permanent → archived
- **Dual storage**: Markdown files (source of truth) + SQLite full-text search index
- **Wiki-links**: Obsidian-compatible `[[slug|display]]` format with backlink tracking
- **Vector search**: Optional embedding support via OpenAI-compatible API
- **CLI installer**: `bunx open-zk-kb` (npm) or `bun run setup` (source) for 4 clients
- **Data migrations**: Agent-driven `upgrade` action for schema evolution
