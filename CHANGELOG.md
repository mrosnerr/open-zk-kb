# Changelog

## 1.0.1

- **Add MCP Registry support** — `server.json` manifest for official registry submission
- **Add `llms.txt`** — machine-readable documentation for AI assistant discovery
- **Add `mcpName` to package.json** — required for MCP registry npm verification
- **Emphasize Zettelkasten identity** — updated descriptions and keywords to highlight the Zettelkasten method

## 1.0.0

First stable release. Highlights from the beta period:

- **5 MCP clients supported** — Claude Code, OpenCode, Cursor, Windsurf, Zed
- **Semantic search** — local MiniLM-L6-v2 embeddings with optional API providers
- **Client-aware filtering** — notes can be scoped to specific clients
- **Dual storage** — Markdown files (source of truth) + SQLite FTS5 index
- **Skill-based instructions** — Claude Code uses `~/.claude/skills/`, others use injected `AGENTS.md`
- **Full test coverage** — 424 tests including E2E MCP protocol tests

## 0.1.0-beta.11

- **Add client-aware knowledge filtering** — detect caller (claude-code, cursor, etc.) and tailor tool outputs
- **Add soft atomicity warnings** — warn when notes exceed size thresholds
- Improve skill structure to prioritize storage triggers over mechanics
- Fold search into pre-flight alongside storage triggers
- Add retrieval guidance to pre-flight instructions
- Add boundary and edge-case tests for atomicity warnings
- Fix review oversized-notes scan: unbounded limit and single countWords pass
- Fix smoke tests for FTS5 query handling and search output matching

## 0.1.0-beta.10

- Add `skills/` to npm package files (fixes claude-code skill install from npm)
- Fix `removeSkill()` to use `force: true` for robustness
- Fix test isolation for skill directory snapshots
- Rewrite MCP protocol tests using proper SDK client
- Fix unknown tool test to assert `isError` flag correctly

## 0.1.0-beta.9

- Improve skill installation code clarity and test cleanup
- Add E2E MCP protocol tests for JSON-RPC tool calls
- Replace CLAUDE.md injection with Claude Code skill for claude-code client

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
