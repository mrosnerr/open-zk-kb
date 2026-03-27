---
layout: post
title: "Why your AI coding assistant needs a knowledge base"
date: 2026-03-10
description: "AI coding assistants forget everything between sessions. Here's how we built a persistent, structured memory using atomic notes, hybrid search, and local embeddings."
---

Every AI coding assistant has the same problem: it forgets.

You explain your architecture. You justify your technology choices. You describe your preferences for error handling, naming conventions, testing strategy. And next session? Gone. You start from scratch.

The common workaround is a flat file — `CLAUDE.md`, `.cursorrules`, a rules file. These work at small scale. But they have a fundamental flaw: **everything gets loaded into context, every time**. Your authentication decisions get injected when you're debugging CSS. Your testing preferences consume tokens when you're writing a README.

## The problem with flat-file memory

Flat files don't scale. At 50 lines, they're fine. At 500 lines, they're burning context window and money on irrelevant information. And they have no concept of relevance — the assistant can't search for what it needs.

They also lack structure. A decision made six months ago sits next to a preference expressed yesterday. There's no way to review, archive, or promote knowledge based on how useful it's proven to be.

## What we built

[open-zk-kb](https://github.com/mrosnerr/open-zk-kb) is an MCP server that gives AI coding assistants a persistent, structured knowledge base. The key ideas:

### One concept per note

This is the most important design choice. Each note captures a single idea — one decision, one preference, one procedure. Not a document. Not a page of loosely related facts. One thing.

This matters more for AI agents than it does for humans, for a few reasons:

1. **Precise retrieval** — when the assistant searches for "how do we handle auth?", it gets back the auth decision note. Not a giant file where auth is mentioned in paragraph 12 alongside database choices and deployment config.

2. **Context window efficiency** — AI agents pay per token. Loading 10 focused notes that are each 5-10 lines is dramatically cheaper than loading a 500-line rules file where 90% is irrelevant.

3. **Composability** — small, typed notes combine naturally. A search for "React patterns" might return a decision about state management, a procedure for component testing, and a preference for functional components. Each stands alone, but together they paint a complete picture.

4. **Natural aging** — a single note can be promoted (this proved useful) or archived (this is stale) independently. In a flat file, outdated information sits next to current information with no way to tell them apart.

### Typed notes with a lifecycle

Notes aren't all the same. Each one has a **kind** — decision, preference, procedure, reference, resource, or observation — and a **lifecycle status**: fleeting, permanent, or archived.

New knowledge starts as fleeting. If the assistant keeps referencing it, it gets promoted to permanent. If it goes stale, it gets archived. This mirrors how real knowledge works: not everything you learn is worth remembering forever. The system surfaces what matters and lets the rest fade.

The types help too. When the assistant is about to make an architectural choice, it can search specifically for past decisions. When it's setting up a new workflow, it looks for procedures. The structure makes search results more relevant.

### Hybrid search: full-text + semantic

When the assistant needs context, it searches — not loads. The search combines two approaches:

1. **Full-text search** for keyword matching — fast, reliable, handles exact terms well
2. **Local vector embeddings** for semantic similarity — finds related concepts even when the wording differs

Both run locally. No API key. No cloud calls. The embedding model (~23MB) downloads once on first use and runs in ~2 seconds on first query, instant after that. Results from both approaches are merged into a single ranked list.

If you ask about "authentication strategy", full-text search finds notes that literally contain those words. Semantic search also finds your note about "JWT token handling" even though it uses different terminology. Together, they cover both precision and recall.

### Markdown files as source of truth

Notes are stored as `.md` files with YAML frontmatter. The SQLite database is an index, not the source of truth. If the database gets corrupted, a single `rebuild` command reconstructs it from the files on disk.

This means your knowledge base is:
- **Human-readable** — open any note in your editor or Obsidian
- **Version-controllable** — commit your knowledge alongside your code
- **Portable** — copy the folder, and your knowledge moves with you

### Agent-driven, not user-driven

The assistant drives everything. The installer injects instructions that teach the assistant to:
- **Search before starting work** — check for relevant context
- **Store knowledge as it discovers it** — decisions, preferences, patterns
- **Maintain the knowledge base** — review aging notes, find duplicates, promote useful knowledge

You don't interact with the knowledge base directly (though you can). The assistant learns what to remember and when to recall it.

## The technical stack

- **TypeScript + Bun** — fast startup, native SQLite
- **SQLite full-text search** — keyword matching with query sanitization
- **Local embeddings** via `@huggingface/transformers` — semantic search, ~23MB download on first use
- **MCP protocol** — works with any MCP-compatible client (Claude Code, Cursor, Windsurf, OpenCode, Zed)
- **Zero configuration** — `bunx open-zk-kb@latest` handles everything

The approach is inspired by the [Zettelkasten method](https://en.wikipedia.org/wiki/Zettelkasten) — a note-taking system built around atomic, linked notes that was originally designed for human researchers. It turns out the same principles (small notes, typed categories, links between ideas) work even better for AI agents, where context window limits make precision essential.

## What's next

open-zk-kb is stable and ready for production use. The core functionality — store, search, maintain — has been validated by real-world usage across multiple MCP clients.

If you're tired of re-explaining your architecture every session, give it a try:

```bash
bunx open-zk-kb@latest
```

- [GitHub](https://github.com/mrosnerr/open-zk-kb)
- [npm](https://www.npmjs.com/package/open-zk-kb)
- [Documentation](https://github.com/mrosnerr/open-zk-kb/tree/main/docs)
