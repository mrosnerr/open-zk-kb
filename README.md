# open-zk-kb

[![CI](https://github.com/mrosnerr/open-zk-kb/actions/workflows/ci.yml/badge.svg)](https://github.com/mrosnerr/open-zk-kb/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/open-zk-kb)](https://www.npmjs.com/package/open-zk-kb)
[![npm downloads](https://img.shields.io/npm/dm/open-zk-kb)](https://www.npmjs.com/package/open-zk-kb)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

You open a new session and your agent has no idea who you are. Again. You re-explain your stack, your conventions, that one edge case you've corrected five times.

open-zk-kb gives your agent a memory — so corrections stick, context compounds, and every session starts smarter than the last.

<p align="center">
  <a href="assets/pi-demo.mp4">
    <img src="assets/pi-demo.png" alt="A healthy 240-note open-zk-kb vault rendered natively in Pi" width="760">
  </a>
  <br>
  <sub>240 linked, embedded notes and automatic preference injection in Pi. <a href="assets/pi-demo.mp4">Watch the 47-second demo.</a></sub>
</p>

## Quick start

> **Requires [Bun](https://bun.sh)** — install with `curl -fsSL https://bun.sh/install | bash`

```bash
bunx open-zk-kb@latest
```

The installer configures your selected clients, installs agent instructions, and creates a local vault. Supported clients: **OpenCode**, **Claude Code**, **Cursor**, **Windsurf**, **Zed**, **Pi**, and **OMP**.

See the [Setup Guide](docs/setup-guide.md) for manual installation and troubleshooting.

## Why open-zk-kb?

Your agent starts from zero every session. No memory, no learning curve. You correct the same mistakes, re-explain the same conventions, re-teach the same context. Switch tools and it's even worse — your Cursor agent doesn't know what your Claude agent learned.

open-zk-kb fixes that.

- **Correct it once, it sticks** — your agent stores corrections, preferences, and decisions. Next session, it already knows.
- **Works across every tool** — one knowledge base shared by [Claude Code, Cursor, Windsurf, OpenCode, Zed, Pi, and OMP](docs/setup-guide.md)
- **Finds what's relevant** — hybrid search matches meaning, not just keywords, so only useful context surfaces
- **Runs locally** — no API keys, no cloud, works offline. Your data stays on your machine.
- **Human-readable** — plain Markdown files [you can browse, edit, and version control](docs/architecture.md#dual-storage-model)
- **Open source** — MIT licensed

## How it works

1. **You install it** — one command, picks up your client automatically
2. **Your agent stores what it learns** — corrections, preferences, decisions, gotchas, workflows
3. **Next session, it searches first** — relevant context surfaces before your agent writes a single line

Your agent gets sharper the longer you use it — for *your* specific workflow.

### Preferences follow you into the next session

<table>
  <tr>
    <td align="center"><a href="assets/pi-preference-store.png"><img src="assets/pi-preference-store.png" alt="Store a cooking-metaphor preference in Pi"></a></td>
    <td align="center"><a href="assets/pi-preference-application.png"><img src="assets/pi-preference-application.png" alt="Pi automatically applies the stored preference in a new session"></a></td>
    <td align="center"><a href="assets/pi-preference-removal.png"><img src="assets/pi-preference-removal.png" alt="Remove the preference through a native knowledge-maintain result"></a></td>
  </tr>
  <tr>
    <td align="center"><strong>1. Store it</strong><br><sub>A native tool result confirms the durable preference.</sub></td>
    <td align="center"><strong>2. Start fresh</strong><br><sub>The next session loads it automatically—no search call needed.</sub></td>
    <td align="center"><strong>3. Stay in control</strong><br><sub>Remove it whenever it stops being useful.</sub></td>
  </tr>
</table>

Click any screenshot to inspect the full-size Pi output, or see the [complete Pi experience](docs/pi.md).

## Browse your notes in Obsidian

Your knowledge base is a fully themed [Obsidian](https://obsidian.md) vault — homepage dashboard, kind-based folders with icons, breadcrumb navigation, and quick-add buttons. No manual setup.

<p align="center">
  <img src="assets/obsidian-home.png" alt="Knowledge base in Obsidian" width="640">
  <br>
  <sub>Homepage with project stats, navigation, and your full knowledge graph.</sub>
</p>

See the [Obsidian Guide](docs/obsidian.md) for the full walkthrough.

## Pi: native knowledge tools

Install the Pi package, then restart Pi:

```bash
pi install npm:open-zk-kb
```

The extension exposes all ten `knowledge-*` tools directly in Pi. Results use Pi-native compact rendering: search, store, context, and health have focused summaries and expandable detail, while the other tools show concise status output. The MCP server and local SQLite/embedding work still run with **Bun >= 1.0**; Pi itself runs under its supported Node.js runtime. Installing Bun is therefore required even when using the Pi package.

Pi also loads active project preferences automatically when a session starts and injects them into model context without requiring a model-initiated search. The visible `knowledge-context` entry reports what happened without fabricating a tool call.

See the [Pi experience guide](docs/pi.md) for the complete preference workflow and renderer examples. For installer-managed instructions, verification, and troubleshooting, see [Pi installation](docs/setup-guide.md#pi-installation).

## Configuration

Zero configuration required. Local embeddings work out of the box with no API key.

See the [Configuration Guide](docs/configuration.md) for embeddings, vault path, lifecycle tuning, and Obsidian scaffold options.

## Under the hood

Built on the Zettelkasten method — atomic, linked notes with structured kinds. Each note captures one concept (a decision, a preference, a gotcha) and links to related notes, building an interconnected knowledge graph.

Search combines SQLite FTS5 full-text indexing with local vector embeddings (MiniLM-L6-v2) for semantic matching. Markdown files are the source of truth; the database is a rebuildable index.

## Telemetry

When opted in (`telemetry.enabled: true` and `telemetry.share: true`), open-zk-kb sends anonymous session analytics to [PostHog](https://posthog.com) (EU Cloud) — which client and models you use, vault size, and tool usage counts. No note content, search queries, or personal data is ever collected. Both flags are disabled by default. Set `DO_NOT_TRACK=1` to unconditionally block sharing (local SQLite counters are unaffected). Set both flags to `false` to disable all telemetry entirely. See [Telemetry](docs/telemetry.md) for the full event schema and details.

## Documentation

- [Setup Guide](docs/setup-guide.md) — installation, client-specific setup, troubleshooting
- [Pi Experience](docs/pi.md) — native tools, automatic preferences, and renderer gallery
- [Tools Reference](docs/tools-reference.md) — all 10 MCP tools with parameters and examples
- [Note Lifecycle](docs/note-lifecycle.md) — note kinds, statuses, review system
- [Configuration](docs/configuration.md) — embeddings, vault, Obsidian scaffold
- [Obsidian Guide](docs/obsidian.md) — managed scaffold, plugins, navigation
- [Architecture](docs/architecture.md) — dual storage, ownership model, design decisions
- [Development](docs/development.md) — local dev, testing, debugging
- [Contributing](.github/CONTRIBUTING.md) — guidelines for contributors

## License

[MIT License](LICENSE)
