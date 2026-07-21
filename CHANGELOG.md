# Changelog

## 1.4.1

### Changed

- **Streamlined README experience** — replaced the static Pi header with the complete animated preference workflow and removed redundant walkthrough and Obsidian sections from the main README

## 1.4.0

### Added

- **Shared tool metadata** — single source of truth for all 10 tools in `src/tool-meta.ts` with framework-agnostic `ParamDef` and generators for Zod (MCP) and TypeBox (Pi) schemas
- **Pi extension improvements** — MCP bridge with HTTP-first transport, all 10 tools registered natively with `promptSnippet`, `promptGuidelines`, and `executionMode`
- **Structure hints in knowledge-store** — per-kind content structure hints embedded in tool description (decision, procedure, observation, reference, domain)
- **kb-session-review skill** — Pi skill for self-reviewing KB usage quality
- **Pi package discoverability** — `pi.skills`, `pi.image` in package manifest, expanded keywords
- **Obsidian vault defaults** — new vaults default to dark mode with sidebar open (#181)

### Changed

- Renamed `skills/` → `skill-templates/` for Claude Code templates (Pi skills now in `skills/`)
- `knowledge-template` restricted to kinds with actual template files (`TEMPLATE_KINDS`)
- Pi SDK types moved to optional peer dependencies

### Fixed

- Pi extension bridge no longer resets transport on tool-level MCP errors — only transport/protocol failures trigger reset
- Version-check CI workflow updated for `skill-templates/` path
- `actions/setup-node` SHA comment updated to v7

## 1.3.0

### Added

- **Anonymous usage analytics** — anonymous session telemetry via PostHog (EU Cloud). One `session` event per cleanly ended MCP server session, reported on the next startup. Contains client, models, version, platform, vault size, and tool usage counts. No note content, search queries, or personal data. Both `telemetry.enabled` and `telemetry.share` must be `true` to send data. `DO_NOT_TRACK=1` unconditionally blocks sharing. See [docs/telemetry.md](docs/telemetry.md)
- **Install telemetry prompt** — interactive installations ask about anonymous analytics. Use `--no-telemetry` to skip. Defaults to opt-out (pressing Enter declines)
- **Model tracking** — distinct model IDs per session for usage correlation
- **Patch integrity CI** — pinned `@huggingface/transformers` to exact `4.0.1` with CI validation and test coverage for the WASM plugin patch

### Fixed

- Strip `patchedDependencies` from published npm package to avoid breaking consumers
- Record session end on stdin close for reliable session reporting
- TTL-based claim recovery prevents concurrent startups from interfering
- Deferred telemetry config write until after successful install
- Wrap claim transaction with `withBusyRetry` for SQLite busy resilience

### Changed

- Startup telemetry gated on `config.telemetry.enabled` — no eager vault/DB creation when disabled
- Repo hygiene: gitignore cleanup, patch wiring, file modes

## 1.2.0 - 2026-07-09

### Added

- **Add `--remove-shared-agent-docs` uninstall flag** — removes managed instructions from symlinked shared files when the user explicitly opts in
- **Split OMP instructions by responsibility** — OMP now installs a compact preflight rule, an on-demand skill, and a TTSR enforcement rule instead of one monolithic rule

### Changed

- **Slim injected agent instruction block** — moved detailed guidance to the skill and `knowledge-template` output, reducing managed client instructions to the core pre-flight and storage rules
- **Compact `knowledge-store` output** — store responses now use `Stored <kind>: "title" → id` instead of the previous multi-line Kind/Status/Lifecycle/Path format

### Fixed

- **Block OMP rediscovery after uninstall** — uninstall now disables rediscovery for OMP-managed servers so removed MCP entries do not come back automatically
- **Preserve the OMP preflight rule during maintenance** — `knowledge-maintain agent-docs` no longer overwrites the OMP preflight rule with the wrong instruction payload
- **Clean leftover uninstall artifacts without client config** — uninstall no longer skips remaining skills, rules, or managed docs just because a client's config file is absent

## 1.1.0

### New MCP Tools

- **Add `knowledge-template` tool** — canonical note templates per kind with positive/negative examples, so agents produce well-structured notes
- **Add `knowledge-mine` tool** — bulk-screen candidate notes from session history for duplicates; dry-run preview then store confirmed candidates
- **Add `knowledge-ingest` tool** — extract article content from URLs or raw HTML into clean markdown with SSRF protection, redirect provenance, and size guards
- **Add `knowledge-overview` tool** — per-project overview combining auto-generated index (catalog of all notes grouped by kind) and recent operations log
- **Add `knowledge-open` tool** — detect Obsidian, auto-register vault, and launch with URI scheme or binary spawn

### New Note Kinds

- **Add `domain` kind** — project operating manuals defining agent role, scope, conventions, and boundaries; one per project, always surfaced in project-scoped searches
- **Add `index` and `log` kinds** — auto-generated per-project navigation notes; `index` catalogs all notes with wikilinks grouped by kind, `log` appends chronological events

### Obsidian Integration

- **Add kind-based vault directories** — notes organized into subdirectories by kind with global MOC (Map of Content) navigation and sub-MOC indexes
- **Add managed Obsidian scaffold** — pinned theme, plugins (Dataview, Templater, QuickAdd, Homepage), CSS snippets, templates, and upgrade metadata; auto-upgrades on launch
- **Add vault auto-registration** — vault registered in Obsidian before URI launch with dedup guard
- **Add Obsidian config surface** — `obsidian.autoUpgrade` and `obsidian.readOnly` settings in `config.yaml`

### Note Lifecycle & Intelligence

- **Add `lifecycle` field** — `living` (mutable, default), `snapshot` (immutable), `append-only`; server enforces immutability for decisions and observations
- **Add `staleness_days` metric** — surfaced in search, store, and review responses; days since last access for freshness assessment
- **Add related notes on store** — `knowledge-store` returns similar notes by embedding similarity to help agents link knowledge
- **Enhance review curation UX** — structured age bucketing, auto-archive suggestions for stale fleeting notes, deduplication in review queue

### Maintenance & Quality

- **Add unlinked note and broken wikilink detection** — `knowledge-maintain unlinked` and `knowledge-maintain broken-links` with line numbers and content-relative positions
- **Add model-aware capability detection** — agents self-report model identity for tiered feature gating

### Infrastructure

- **Add schema v7** — telemetry table for local-only, opt-in tool invocation counters (no content or query strings stored)
- **Improve SKILL.md** — lifecycle guidance, examples, and boundaries for Claude Code skill users

## 1.0.11

- **Add Claude Code plugin packaging** — compiled binaries for macOS, Linux, and Windows
- **Add CodeRabbit config** — automated code review with request changes workflow
- **Add runtime validation** — package.json version fallback for compiled binaries
- **Bump @huggingface/transformers** — 3.8.1 to 4.0.1
- **Bump @typescript-eslint/eslint-plugin and parser** — 8.26.0 to 8.58.1 (eslint 10 compat)
- **Sync plugin.json version in release script** — ensures version consistency

## 1.0.10

- Standardize taglines to short and long variants
- Remove coding-specific terminology from taglines

## 1.0.9

- Update taglines to emphasize Zettelkasten method and shared KB

## 1.0.8

- Use Node 24 for npm trusted publishing (#63)

## 1.0.7

- Remove flaky npm upgrade step from publish workflow (#60)

## 1.0.6

- Pin npm version in CI (#58)

## 1.0.5

- Shorten server.json description for MCP Registry (#56)

## 1.0.4

- Add MCP Registry publishing to CI (#54)

## 1.0.3

- Sync versions across all files on release

## 1.0.2

- **Add version tracking to stats** — shows installed instruction version to help identify when reinstall is needed
- **Pre-select installed clients** — interactive installer now pre-selects already-installed clients
- **Update GitHub Actions to Node.js 24** — compatibility with latest runner versions

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
