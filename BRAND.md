# Brand & Voice Guide

> **This document governs all outward-facing copy**: README, docs, GitHub descriptions, release notes, social posts, and any agent-generated text about the project.

## Core Positioning

One truth, two framings.

- **The pain**: "Your agent doesn't learn from you."
- **The payoff**: "Correct it once. It sticks."

Everything else is supporting detail. Lead with the pain. Follow with the payoff.

**Supporting hooks** (use to illustrate, not to lead):
- "Stop re-explaining yourself every session."
- "Every session makes the next one better."
- "One memory, shared across every tool you use."

## Tagline

> Your agent doesn't learn from you. This fixes that.

Use this as the primary one-liner anywhere a short description is needed (GitHub repo description, npm package summary, social bios). Shorten to "Persistent memory for AI agents" when character-limited.

## The Aha Moment

This is what makes someone care. Use it in onboarding copy, demos, and introductions.

> You notice your agent keeps structuring responses wrong — or forgetting your conventions for the third time. You correct it. Next session, different tool, different day — the correction is already there. It learned. That's the moment it clicks: your agent is actually getting better at working with *you*.

## Terminology

Use **"agent"** as the primary term in all outward-facing copy. Use "AI" only when referring to the broader category (e.g., "AI tools" as a market). Do **not** qualify with "coding" — open-zk-kb works for any agent, not just coding agents.

| Context | Use |
|---------|-----|
| Talking about the user's tool | "your agent" |
| Referring to the market / category | "AI tools," "agents" |
| Generic plural | "agents" |
| Never | "AI assistant," "coding agent," "LLM," "the model" (in user-facing copy) |

## Audience

People who work with agents daily — and anyone curious about what that looks like.

This includes:
- Developers who use agents daily and feel the memory gap
- Tech leads evaluating agent tooling for their team
- Non-technical users who rely on agents for research, writing, or workflows
- Anyone who's corrected their agent for the same thing twice and felt the frustration

**Assume they're smart but don't assume they know MCP, Zettelkasten, or how embedding search works.** Explain outcomes, not plumbing.

## Voice Principles

### 1. Confident — from experience, not authority
State what the tool does plainly. No hedging ("might help," "could potentially," "aims to"). This solves a real problem — say so. But speak from lived use, not a pedestal.

- ✅ "Your agent remembers your preferences, decisions, and project context."
- ❌ "This tool might help your AI assistant potentially remember some context."

### 2. Direct, not terse
Get to the point. Use short sentences. But don't sacrifice clarity for brevity — if something needs a sentence to explain, give it a sentence.

- ✅ "One knowledge base shared across Claude Code, Cursor, Windsurf, and Zed."
- ❌ "Cross-client KB via MCP stdio transport layer."

### 3. Second person — talk to the reader
Use "you" and "your." This is about their workflow, their frustration, their improvement.

- ✅ "Your agent forgets everything between sessions. This fixes that."
- ❌ "AI assistants lack persistent memory across sessions."

### 4. Show the frustration, not just the problem
Don't just name the problem — make it feel familiar. The reader should think "yeah, exactly" before you offer the fix.

- ✅ "You open a new session and your agent has no idea who you are. Again. You re-explain your stack, your conventions, that one edge case you've corrected five times."
- ❌ "AI assistants forget context between sessions."

### 5. Plain language over jargon
If a simpler word works, use it. Technical terms are fine when they're the right tool — but never to sound impressive. However, keep the technical terms discoverable — people search for them even if they shouldn't be the first thing they read.

| In copy, avoid | In copy, prefer | Keep in metadata (SEO, keywords, topics) |
|----------------|-----------------|------------------------------------------|
| Zettelkasten method | structured notes / atomic notes | zettelkasten, zettelkasten-ai |
| knowledge management system | memory, knowledge base | knowledge-management |
| MCP server | works with your agent tools | mcp, mcp-server, model-context-protocol |
| FTS5 + embeddings | hybrid search / finds what's relevant | fts5, embeddings, semantic-search |
| dual storage model | human-readable files backed by a fast index | sqlite |
| stdio transport | runs locally, no server needed | — |
| Obsidian plugin | browse your notes visually | obsidian, knowledge-graph |

**Principle**: Jargon in the metadata, plain language in the copy. Someone finds you through "zettelkasten AI tool" but reads "your agent doesn't learn from you" when they land.

**Exception**: In developer docs and architecture docs, use precise technical terms freely. The simplification applies to outward-facing copy (README, landing pages, descriptions). A "deeper dive" section near the bottom of the README or landing page can use these terms for readers who already know them.

### 6. Speak from the inside
Write like someone who uses this daily, not someone describing it from the outside. Use specific, lived-in details over generic ones.

- ✅ "Tired of re-explaining that weird build flag? Store it once."
- ❌ "Store your preferences and project context for future reference."

## Key Messages

Use these as building blocks. Mix and match per context.

### The Problem
- Your agent starts from zero every session — no memory, no learning curve.
- You correct the same mistakes, re-explain the same conventions, re-teach the same context.
- Switching tools means starting over — your Cursor agent doesn't know what your Claude agent learned.

### The Solution
- Persistent memory your agent checks automatically, every session.
- Corrections, preferences, decisions, gotchas — stored once, applied everywhere.
- One knowledge base shared across every agent tool you use.

### The Payoff
- Correct it once. It sticks.
- Your agent gets sharper the longer you use it — for *your* specific workflow.
- Context compounds — what you teach it once, it knows forever.

### The Differentiators
- Works across Claude Code, Cursor, Windsurf, OpenCode, Zed, Pi, and OMP.
- Local-first — no API keys, no cloud, works offline.
- Human-readable — plain Markdown files you can browse in Obsidian.
- Open source, MIT licensed.

## Formatting Rules

1. **Headlines are outcomes, not features.** "Your agent remembers" > "Persistent storage layer"
2. **Bullet points are punchy.** One idea per bullet. No run-on bullets.
3. **Code examples are real.** Never show hypothetical output. Show actual MCP calls.
4. **No exclamation marks.** Confidence doesn't shout.
5. **No emoji in body copy.** OK in changelogs, commit messages, and status badges.

## Contexts

### GitHub Repo Description (one line)
> Your agent doesn't learn from you. This fixes that. Persistent memory across Claude Code, Cursor, Windsurf, and more.

### README Opener
> You open a new session and your agent has no idea who you are. Again. open-zk-kb gives your agent a memory — so corrections stick, context compounds, and every session starts smarter than the last.

### Casual Explanation (to a friend)
> "You know how every new chat, you have to re-explain your whole project? And your agent keeps making the same mistakes you've already corrected? I built the thing that fixes that. You correct it once, it remembers. And it gets better the more you use it."

### Technical Pitch (to developers)
> "It's an MCP server that gives agents persistent, structured memory. Local SQLite + Markdown, hybrid search, works across seven clients. Your agent checks it every message — preferences, decisions, gotchas, corrections, all there."

## What We Don't Say

- ❌ "Knowledge management system" — sounds like enterprise middleware
- ❌ "Zettelkasten-based" as a lead — it's an implementation detail, not a feature
- ❌ "Might," "could," "aims to," "helps to" — hedging language
- ❌ "Powerful," "robust," "cutting-edge" — empty adjectives
- ❌ "AI-powered" — everything is AI-powered, this means nothing
- ❌ "Second brain" — overused, and this is your *agent's* brain, not yours
- ❌ "AI assistant" — use "agent" (see Terminology section)
