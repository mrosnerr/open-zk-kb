---
layout: home
title: open-zk-kb
---

# Persistent memory for AI coding assistants

Your AI assistant forgets everything between sessions. open-zk-kb fixes that.

It gives your assistant a **structured, searchable knowledge base** it queries automatically — so your preferences, decisions, and context persist across every conversation.

## How it works

1. **Install in one command** — `bunx open-zk-kb`
2. **Your assistant stores knowledge** — decisions, preferences, patterns, procedures
3. **Next session, it searches first** — relevant context surfaces automatically

Notes are Markdown files with YAML frontmatter. A SQLite index provides full-text search, with local vector embeddings for semantic matching. No API key needed. No cloud required.

## Key features

- **Hybrid search** — full-text + semantic embeddings, so results match meaning not just keywords
- **Atomic notes** — one concept per note, typed (6 kinds) with lifecycle management (fleeting, permanent, archived)
- **Local-first** — everything stays on your machine, no API keys required
- **Multi-client** — Claude Code, Cursor, Windsurf, OpenCode
- **Human-readable** — Markdown files you can browse, edit, and version control
- **Rebuild from files** — database is an index; your `.md` files are the source of truth
- **MIT licensed** — use it however you want

## Quick start

```bash
bunx open-zk-kb
```

The interactive installer adds the MCP server to your client and injects instructions that teach your assistant when and how to use the knowledge base.

## Learn more

- [GitHub Repository](https://github.com/mrosnerr/open-zk-kb)
- [npm Package](https://www.npmjs.com/package/open-zk-kb)
- [Setup Guide](https://github.com/mrosnerr/open-zk-kb/blob/main/docs/setup-guide.md)
- [Tools Reference](https://github.com/mrosnerr/open-zk-kb/blob/main/docs/tools-reference.md)
- [Architecture](https://github.com/mrosnerr/open-zk-kb/blob/main/docs/architecture.md)
