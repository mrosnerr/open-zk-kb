# Discovery Platform Rollout

## Gate

**Blocked until**: `dev` merged to `main` and v1.1.0 published to npm.
Dev is 271 commits ahead — this plan executes AFTER that release lands.

## Current State (May 2026)

- npm: published (v1.0.11, 656 downloads/month)
- Everything else: absent
- Direct competitor `zettelkasten-mcp` (150 stars, Python, less capable) is already listed on awesome-mcp-servers

## Why v1.1.0 First

1. 271 commits of unreleased work — listings should point to the best version
2. README/docs may change during merge — submission content should be final
3. One-command install (`bunx open-zk-kb@latest`) should resolve to latest

---

## Phase 1: Awesome Lists (Day 1 post-release)

### 1A. awesome-opencode (6.7K stars)

- **Repo**: `awesome-opencode/awesome-opencode`
- **Process**: Create YAML file in `data/plugins/`, open PR
- **File**: `data/plugins/open-zk-kb.yaml`
- **Content**:
  ```yaml
  name: open-zk-kb
  repo: https://github.com/mrosnerr/open-zk-kb
  tagline: Shared persistent memory for AI assistants, built on Zettelkasten
  description: >-
    Zettelkasten-based knowledge base with SQLite FTS5, local embeddings,
    Markdown files, Obsidian integration, and 9 MCP tools.
    Works with OpenCode, Claude Code, Cursor, Windsurf, Zed, Pi, and OMP.
  ```
- **Why first**: Smallest review queue, OpenCode-native, YAML-only PR
- **Effort**: 15 min

### 1B. awesome-mcp-servers (86.7K stars)

- **Repo**: `punkpeye/awesome-mcp-servers`
- **Process**: Fork, edit README.md, add entry in Knowledge & Memory section (alphabetical), PR
- **Format**: `- [mrosnerr/open-zk-kb](https://github.com/mrosnerr/open-zk-kb) 📇 🏠 - Zettelkasten-based persistent memory with SQLite FTS5, local embeddings, Obsidian integration. 9 MCP tools across 7 AI clients.`
- **Fast-track**: Add `🤖🤖🤖` to PR title for automated merge
- **Category**: Knowledge & Memory (159 entries, alphabetical ordering)
- **Effort**: 20 min

---

## Phase 2: MCP Registries (Day 1-2 post-release)

### 2A. Smithery.ai (8.6K servers)

- **Status**: Ghost profile exists (empty page at `smithery.ai/server/mrosnerr/open-zk-kb`)
- **Fix**: Add `smithery.yaml` to repo root OR publish at `smithery.ai/servers/new`
- **Competitors present**: Synapse Layer (2,130 uses), DejaView (669), mem0 (139 verified)
- **Effort**: 20 min

### 2B. Glama.ai (23K servers, 1,198 in Knowledge & Memory)

- **Process**: Click "Add Server" — auto-indexes from GitHub
- **May need**: proper MCP manifest or `server.json` in repo
- **Effort**: 10 min

### 2C. mcp.so (20K servers)

- **Process**: Open GitHub issue at `chatmcp/mcpso` with repo URL
- **Effort**: 10 min

---

## Phase 3: Stretch Targets (Week 1 post-release)

### 3A. GitHub MCP Registry (97 curated servers)

- **Repo**: `modelcontextprotocol/registry`
- **Process**: PR with server metadata
- **Reality check**: Very high bar — only 97 servers, mostly major orgs (Microsoft, Stripe, Figma)
- **Worth attempting**: Yes, but expect rejection. The attempt itself may surface what's needed for future acceptance
- **Effort**: 30 min

### 3B. Secondary Directories

Submit to whichever are still active at time of execution:
- mcpservers.org (by wong2)
- mcprepository.com
- mcp-hunt.com (Product Hunt style)
- opentools.com
- pulsemcp.com (community hub + newsletter)

Batch these — most are "paste URL" submissions.
- **Effort**: 30 min total

### 3C. OMP Marketplace

- **Docs**: https://omp.sh/docs/extension-authoring → "Ship it through a marketplace"
- **Format**: Git repo with `.claude-plugin/marketplace.json` catalog
- **Pre-work**: Migrate `pi` → `omp` key in `package.json` (legacy `pi.extensions` still works but `omp.extensions` is recommended). Handle dual-load concern: if someone installs via both `omp install` AND MCP config, the extension bridge and MCP server would create duplicate tools. Extension should detect OMP and skip tool registration when MCP is already available.
- **Effort**: 1-2 hours (includes package.json migration + duplicate-detection logic + marketplace catalog PR)
- **Blocked on**: Resolving the extension vs MCP dual-load conflict first

---

## Phase 4: Content (Week 2 post-release)

### 4A. Technical Blog Post

- **Title idea**: "Building Cross-Session Memory for AI Coding Assistants"
- **Platform**: dev.to or personal blog (cross-post to Hashnode)
- **Angle**: Technical deep-dive, not marketing. Cover:
  - Why AI assistants forget (the problem)
  - Zettelkasten as a knowledge structure for agents
  - Dual storage architecture (SQLite + Markdown)
  - Local embeddings without API keys
  - Multi-client challenge (7 clients, different config formats)
- **Do NOT**: Pitch the project in the intro. Let the engineering speak.
- **Effort**: 2-4 hours

### 4B. Plugin for anthropics/financial-services

- **What**: A "persistent memory" plugin that uses open-zk-kb as the backend
- **Why**: 20K stars, open plugin architecture, financial agents need memory
- **Format**: Markdown plugin following their `plugins/` structure
- **Effort**: 1-2 hours
- **Risk**: May be rejected, but the PR itself gets eyeballs

---

## Checklist (copy to issue when executing)

- [ ] Gate: v1.1.0 released to npm from main
- [ ] Phase 1A: PR to awesome-opencode
- [ ] Phase 1B: PR to awesome-mcp-servers
- [ ] Phase 2A: Smithery listing fixed
- [ ] Phase 2B: Glama.ai listed
- [ ] Phase 2C: mcp.so listed
- [ ] Phase 3A: GitHub MCP Registry PR (stretch)
- [ ] Phase 3B: Secondary directories batch
- [ ] Phase 4A: Blog post published
- [ ] Phase 4B: financial-services plugin PR (stretch)

## Success Metrics (30 days post-rollout)

- Listed on 5+ discovery platforms (from current 1)
- GitHub stars: 50+ (from 1)
- npm downloads: 2,000+/month (from 656)
- At least 1 awesome-list PR merged

---

## Appendix: Competitive Intelligence

### Case Study: OpenAgentsControl (darrenhinde/OpenAgentsControl)

**Stats**: 3,979 stars, 328 forks, created Aug 2025, last commit Mar 25 2026 (stale 7+ weeks).

Investigated to understand how a solo-dev project in the same ecosystem gained ~4K stars.

#### Star Growth Pattern

```
Aug 2025  repo created
Oct 31    ⭐ #1         2.5 months to first star
Dec 30    ⭐ #100       ~2 months
Jan 19    ⭐ #500       3 weeks ← YouTube-driven acceleration
Feb 17    ⭐ #1,000     ~1 month
Mar 28    ⭐ #2,000     ~6 weeks
May 7     ⭐ #3,000     ~6 weeks (steady)
May 12    ⭐ #3,979     slowing, no commits in 7 weeks
```

#### What Drove Growth

1. **YouTube funnel** — "15 Minutes to Fix Your AI Dev Workflow" got 39.9K views (Oct 2025). Built audience before OAC launched, then funneled to repo
2. **30KB README as sales page** — hero image, problem/solution framing, before/after code, comparison table naming Cursor/Copilot/Aider, explicit "Star the repo ⭐" CTA (twice), social proof badges
3. **GitHub topic SEO** — 9 topics targeting high-volume searches: `ai-agents`, `ai-agents-framework`, `code-generation`, `developer-tools`, `opencode`
4. **Ecosystem piggybacking** — rode OpenCode's growth, positioned as "the missing control layer"
5. **Consistent personal brand** — "DarrenBuildsAI" across YouTube, X, Threads, LinkedIn, GitHub
6. **Auto-indexed directories** — Context7, DeepWiki, Nerq (84/100), PT-Edge (64/100), Sourcevana, SourcePulse

#### What It Does NOT Have

- awesome-mcp-servers: not listed
- awesome-opencode: not listed
- Reddit: zero posts
- HackerNews: never submitted
- ProductHunt: no launch
- Newsletters: not featured
- npm downloads: ~0 (installs via `curl | bash`)
- Community contributors: 15 people, mostly 1-commit drive-bys
- 88.5% of commits from solo author

#### Key Insight

Stars ≠ users. OAC has ~4K stars and ~0 npm downloads. open-zk-kb has 1 star and 656 npm downloads/month. **We have more real users; they have more vanity metrics.** The gap is discovery and marketing, not product quality.

#### Tactics Worth Adopting

| Tactic | Priority | Notes |
|---|---|---|
| YouTube demo video | High | One good video drove OAC's entire growth curve |
| GitHub topic optimization | High | Free. Add `ai-memory`, `cross-session-memory` to existing topics |
| Comparison table in README | Medium | Names competitors, appears in search results. Risk: can look petty |
| Hero image in README | Low | Nice-to-have. We already have demo GIF + Obsidian screenshot |
| Consistent cross-platform brand | Low | Long-term play, not urgent |

#### Tactics to Skip

| Tactic | Why |
|---|---|
| 30KB marketing README | Ours is clean and technical. Don't bloat. A separate landing page is better |
| `curl \| bash` install | We already have `bunx` which is superior |
| Comparison table trash-talking | OAC's table misrepresents competitors ("Oh My OpenCode: Fully autonomous, No approval gates, High token usage"). Inaccurate comparisons damage trust |

### Case Study: anthropics/financial-services

**Stats**: 20,228 stars, 2,654 forks, created Feb 2026 (~2.5 months old).

#### Why It Has 20K Stars

Pure brand leverage. Anthropic's name = instant credibility and distribution.

- Content is mostly markdown & YAML — plugins, skills, templates. No build step
- Technically shallow compared to open-zk-kb (no real code, no tests, no CI logic)
- Has partner integrations (LSEG, S&P Global) that add institutional credibility
- Targets financial services — high-value audience that amplifies reach

#### Applicable Tactic

- **Build a "persistent memory" plugin for their repo** — their 20K eyeballs, open plugin architecture, financial agents genuinely need cross-session memory. Even a rejected PR gets visibility (Phase 4B in plan)
