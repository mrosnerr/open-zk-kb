# Minimal-Context Retrieval Plan

## Problem

open-zk-kb imposes avoidable overhead on agent context windows through three compounding mechanisms:

1. **Always-loaded instruction bloat** — Pi and OpenCode install ~1200-token AGENTS.md blocks that mandate `knowledge-search` before every message. OMP uses a smaller `alwaysApply` preflight rule but can accumulate stale global blocks.
2. **Verbose default tool responses** — `knowledge-search` returns full note `<content>` for all 10 default results. Store appends related notes. Maintain/review/overview/ingest concatenate long lists.
3. **Poor note quality** — Oversized notes, empty summary/guidance, weak conformance enter the vault because checks are advisory-only. This makes summary-first retrieval unreliable.

These multiply in delegated agent systems: each subagent may reload instructions, re-run broad searches, and receive full-content results it doesn't need.

### Who is affected most

| Client | Always-loaded cost | Delegation multiplier | Why |
|---|---|---|---|
| **Pi** | ~1200 tokens (full block) | High — subagent re-inherits | Full AGENTS.md + plugin `before_agent_start` injection |
| **OpenCode** | ~1200 tokens (full block) | High — subagent re-inherits | Full AGENTS.md managed block |
| **OMP** | ~200 tokens (preflight rule) | Medium — rule is small but stale globals compound | `alwaysApply` preflight + skill on-demand + TTSR runtime |
| **Claude Code** | ~500 tokens (rules file) | Low — skill is on-demand | Rules file always-loaded; SKILL.md only on invocation |
| **Windsurf** | ~200 tokens (compact block) | Low — single-session typical | Compact managed block |

Single-agent sessions pay the overhead once. Multi-agent delegation multiplies always-loaded blocks and broad searches across subagents.

---

## Architecture

### Layered retrieval model

```
+-------------------------------------------------+
|  Layer 1: Always-loaded stub (~50 tokens)        |  Static. Installed by setup.
|  Storage triggers + "use compact search when     |
|  KB context is relevant"                         |
+-------------------------------------------------+
|  Layer 2: Bootstrap capsule (~200-400 tokens)    |  Dynamic. Session-start or first-call.
|  User preferences + project domain summary +     |  Via knowledge-overview mode=compact
|  top decisions/procedures as summary cards        |  or equivalent.
+-------------------------------------------------+
|  Layer 3: Compact search (~50 tokens/result)     |  On-demand. Agent queries when relevant.
|  id, title, kind, status, score, summary,        |  Batched multi-query supported.
|  guidance, word_count, content_preview            |
+-------------------------------------------------+
|  Layer 4: Full content (~variable)               |  Explicit. Agent selects specific IDs.
|  Complete note body via knowledge-get             |  Batch get supported with caps.
+-------------------------------------------------+
```

### Design principles

- **Static installed instructions cannot know the task.** They carry behavioral rules only, never "relevant" project context.
- **Dynamic bootstrap context summarizes what matters.** Requires a runtime hook (plugin `before_agent_start`, first tool call, etc.) to compute.
- **Compact is the default; full is explicit.** Agents pick which notes deserve full retrieval after seeing summaries.
- **Server computes, agent judges.** Scoring, ranking, truncation are server-side. Relevance decisions stay with the agent.
- **Note quality is a prerequisite.** Summary-first retrieval is useless if summaries are empty or notes are oversized blobs.

---

## Phases

### Phase 0: Benchmarks and baselines

**Goal**: Establish measurable baselines before changing anything.

| Change | File(s) | Detail |
|---|---|---|
| Response-size benchmark | `tests/benchmarks/response-size.bench.ts` (new) | Measure token count of search (10 results), overview (project + global), store (with related notes), maintain review, maintain full. Use fixture vault with realistic note sizes. |
| Latency benchmark at scale | `tests/benchmarks/scale-latency.bench.ts` (new) | Generate synthetic vaults at 100, 1K, 5K notes. Measure `searchHybrid`, `searchVector`, `getAll`, `getReviewQueue`, `findSimHashDuplicates` wall time. |
| Delegation context benchmark | `tests/benchmarks/delegation-context.bench.ts` (new) | Measure total tokens in always-loaded instruction block + one search result set + one overview for each client config. |

**Tests**: Benchmarks are informational, not pass/fail. Store baselines in `docs/performance.md` for regression tracking.

**Risk**: Benchmark infrastructure adds test files. Low risk.

---

### Phase 1: Shrink always-loaded instructions

**Goal**: Reduce per-session fixed context cost from ~1200 to ~50 tokens for Pi/OpenCode, and clean stale OMP blocks.

| Change | File(s) | Detail |
|---|---|---|
| New `minimal` instruction size | `src/agent-docs.ts`, `templates/install/agent-instructions-minimal.md` (new) | ~50 tokens. Storage triggers only: "remember/prefer/correct -> store first. Use compact search when KB context would help. Full reference: skill or `knowledge-template`." No kind tables, lifecycle, mining, maintenance. |
| Pi uses `minimal` | `src/setup.ts` — `CLIENT_CONFIGS['pi']` | Change `instructionSize: 'full'` to `'minimal'`. |
| OpenCode uses `minimal` | `src/setup.ts` — `CLIENT_CONFIGS['opencode']` | Change `instructionSize: 'full'` to `'minimal'`. |
| OMP preflight wording | `templates/install/agent-instructions-preflight.md` | Remove unconditional "FIRST tool call" language. Replace with relevance-gated: "when KB context would help." |
| Stale block cleanup | `src/setup.ts` — `doctor` action | Detect and warn about stale `OPEN-ZK-KB` managed blocks in global AGENTS.md files that are symlinked or shared across clients. |
| Deprecate `full` size | `src/agent-docs.ts` | Keep `full` loadable for backward compat but mark deprecated. New installs never use it. |

**Tests**: `tests/setup.test.ts` — update instruction-size assertions for Pi/OpenCode. Add test that `minimal` template is <=80 tokens. Add doctor stale-block detection test.

**Docs**: `docs/setup-guide.md` — document new minimal instruction size. Update client comparison table.

**Risk**: Agents that relied on always-loaded kind reference or maintenance instructions must now use skill or `knowledge-template`. This is the intended behavior.

---

### Phase 2: Note quality gates

**Goal**: Ensure summaries and guidance are trustworthy before relying on summary-first retrieval.

| Change | File(s) | Detail |
|---|---|---|
| Enforce non-empty `summary` and `guidance` | `src/tool-handlers.ts` — `handleStore` | Trim and reject if empty: `return 'Error: summary is required and cannot be empty.'` Same for guidance. |
| Zod schema `min(1)` | `src/mcp-server.ts` | Add `.min(1)` to `summary` and `guidance` Zod schemas. |
| Word-count advisory warning | `src/tool-handlers.ts` — `handleStore` | Keep `atomicityWarning()` as advisory. Add `word_count` to store response so agents see the size. |
| Conformance maps for `personalization` + `resource` | `src/template-handler.ts` | Lightweight: personalization needs Preference; resource needs URL. Add to `CONFORMANCE_KINDS` and `CATEGORY_MAPS`. |
| `knowledge-maintain repair` action | `src/tool-handlers.ts` | New maintain action. Surfaces notes with empty summary/guidance, oversized content, zero conformance as an actionable review list grouped by issue type. Does not auto-modify — agent applies fixes via `knowledge-store` with `existingId`. |
| Batch `upgrade-apply` | `src/tool-handlers.ts`, `src/storage/NoteRepository.ts` | Accept `{noteId, summary, guidance}[]` array. Apply in single transaction. For existing vault backfill. |

**Tests**: `tests/mcp-tools.test.ts` — empty summary/guidance rejection. Conformance for personalization/resource. Repair action output. Batch upgrade-apply. `tests/setup.test.ts` — Zod schema validation.

**Docs**: `docs/tools-reference.md` — document repair action and batch upgrade-apply. `docs/note-lifecycle.md` — document quality expectations.

**Risk (B2 from risk review)**: Non-empty enforcement is a schema-level tightening. Notes that previously stored with empty strings will fail on update. Mitigation: repair action enables backfill; new gates only apply to new stores. Conformance remains advisory, not rejection. Opt-in strict mode via `store.strictConformance` config for later.

---

### Phase 3: Compact search and batch retrieval

**Goal**: Make search return compact result cards by default. Add batch retrieval for efficient multi-note workflows.

#### 3A: Add compact mode (backward-compatible)

| Change | File(s) | Detail |
|---|---|---|
| `renderNoteCompact()` | `src/prompts.ts` | New renderer: id, title, kind, status, tags, staleness, score, word_count, summary, guidance, content_preview (150 chars). No full `<content>`. Adds `<hint>` for `knowledge-get`. |
| `includeContent` param on search | `src/tool-handlers.ts`, `src/mcp-server.ts` | Optional boolean, defaults to `true` in this phase. When `false`, uses `renderNoteCompact`. |
| `word_count` attribute in XML | `src/prompts.ts` — `buildNoteAttrs` | Pre-compute `countWords(content)` and include as attribute. Cheap signal for agents deciding whether to fetch full content. |
| Batch search: `queries` param | `src/tool-handlers.ts`, `src/mcp-server.ts` | Accept `queries: string[]`. Run each through `searchHybrid`, deduplicate results by ID, return grouped by query. Each group uses compact rendering. |
| Batch get: `noteIds` param on `knowledge-get` | `src/tool-handlers.ts`, `src/mcp-server.ts` | Accept `noteIds: string[]` (max 20). Return requested notes. Optional `fields` param to select summary-only vs full content. |
| Cap store related-notes output | `src/tool-handlers.ts` — `handleStore` | Cap at 3 related notes in response (down from 5). Omit staleness from response text. Keep full computation server-side. |
| Cap overview resource list | `src/tool-handlers.ts` — `handleOverview` | Cap resources at 10 (down from 20). Add truncation notice. |

#### 3B: Flip default (coordinated with template/doc updates)

| Change | File(s) | Detail |
|---|---|---|
| Default `includeContent` to `false` | `src/tool-handlers.ts` | Flip after instruction templates and docs are updated. |
| Update tool description | `src/mcp-server.ts` | Change "Returns matching notes with full content" to "Returns matching note summaries. Use knowledge-get for full content." |
| Update all instruction templates | `templates/install/*.md` | Teach compact -> selected full-get workflow. |
| Update skill | `skills/open-zk-kb/SKILL.md` | Document compact default and batch retrieval. |

**Tests**: `tests/mcp-tools.test.ts` — compact rendering, includeContent param, batch search dedup, batch get, response-size assertions. Benchmark: compact vs full response size ratio.

**Docs**: `docs/tools-reference.md` — document new params, batch semantics, compact fields. `docs/performance.md` — update response-size baselines.

**Risk (B1 from risk review)**: Flipping the default is breaking. Mitigation: Phase 3A adds the param with current default preserved. Phase 3B flips only after templates/docs/skills are updated. One-release gap ensures installed clients catch up.

**Risk (W1 from risk review)**: Batch params extend existing tools rather than adding new tools. No new tool registrations needed. `queries` on search and `noteIds` on get are additive optional params.

---

### Phase 4: Delegation guidance and caps

**Goal**: Reduce context overhead in multi-agent workflows.

| Change | File(s) | Detail |
|---|---|---|
| `source` param on search | `src/tool-handlers.ts`, `src/mcp-server.ts` | Optional `source: 'primary' \| 'delegated'`. When `delegated`, force compact mode and cap results at 5. Server-enforced, not behavioral-guidance-only. |
| Delegation section in skill | `skills/open-zk-kb/SKILL.md` | "When dispatching subagents: pass task-relevant note IDs/summaries in the assignment. Subagents should use `source: 'delegated'` and avoid broad searches." |
| Delegation section in minimal template | `templates/install/agent-instructions-minimal.md` | One line: "In delegated contexts, use `source: 'delegated'` for compact results." |

**Tests**: `tests/mcp-tools.test.ts` — `source: 'delegated'` forces compact + cap. Delegation context benchmark updated.

**Docs**: `docs/tools-reference.md` — document `source` param. `docs/architecture.md` — document delegation context model.

**Risk (W2 from risk review)**: Behavioral guidance alone is insufficient. The `source` param gives server-side enforcement. Agents can still call without it, but the recommended path caps overhead.

---

### Phase 5: Hot-path performance

**Goal**: Remove O(N) and O(N^2) patterns from common paths.

| Change | File(s) | Detail |
|---|---|---|
| Replace `getAll(MAX)` calls with targeted SQL | `src/tool-handlers.ts` | Stats flat-count: `WHERE path NOT LIKE '%/%'`. Review oversized: `WHERE LENGTH(content) > ?`. Review long-titles: `WHERE LENGTH(title) > ?`. Overview resources: `WHERE kind = 'resource'`. Each with `LIMIT`. |
| Add `NoteRepository.countBy()` | `src/storage/NoteRepository.ts` | `SELECT COUNT(*) FROM notes WHERE ...` for common filter patterns. Avoid loading rows. |
| Batch `updateLastAccessed` | `src/storage/NoteRepository.ts` | Single `UPDATE ... WHERE id IN (...)` instead of N individual updates. |
| Merge startup vault walks | `src/storage/NoteRepository.ts` — `initializeSchema` | `selfHealIfNeeded` reuses the file list from `rebuildFromFiles` or skips if DB note count matches vault file count. One walk, not two. |
| Scope vector search with SQL WHERE | `src/storage/NoteRepository.ts` — `searchVector` | Apply project/tags/kind/status filters in SQL before loading embeddings. Reduces the set that needs cosine computation. |
| Batch wikilink resolution | `src/storage/NoteRepository.ts` — `syncLinks` | Collect all link slugs, resolve via single `WHERE slug IN (...)`, look up from Map. |

**Tests**: Scale benchmarks from Phase 0 should show measurable improvement. Add regression tests for `countBy` and batch update.

**Docs**: `docs/performance.md` — update latency numbers.

**Risk**: SQL changes must preserve existing query semantics. Each change is independently testable.

---

### Phase 6: Maintenance output caps

**Goal**: Reduce context cost of maintain/review/overview/ingest responses.

| Change | File(s) | Detail |
|---|---|---|
| Review: gate oversized/long-title sections | `src/tool-handlers.ts` | Only show when `scope: 'full'` is passed. Default scope shows candidates only. |
| Dedupe: cap groups and notes per group | `src/tool-handlers.ts` | Max 10 groups, max 5 notes per group. Truncation notice with count. |
| Ingest: cap section content in response | `src/tool-handlers.ts` | Max 3 sections, 200 chars each in response. Full content available via `knowledge-store`. |
| Maintain full: add `summaryOnly` mode | `src/tool-handlers.ts` | When true, output step name + status + error count only. |
| Overview: compact project log rendering | `src/tool-handlers.ts` | Truncate log entries server-side to 100 chars each. |

**Tests**: `tests/mcp-tools.test.ts` — response-size assertions for each capped output. Scope param tests.

**Docs**: `docs/tools-reference.md` — document new params and caps.

**Risk**: Agents that parse maintain output may need adjustment. Caps are additive params with current behavior as default for one release, then flipped.

---

## Rollout order

```
Phase 0 --- benchmarks ------------------------------ can ship independently
Phase 1 --- instruction shrinkage -------------------- can ship independently
Phase 2 --- note quality gates ----------------------- can ship independently
Phase 3A -- compact mode + batch APIs (compat) ------- depends on Phase 2
Phase 4 --- delegation caps -------------------------- depends on Phase 3A
Phase 5 --- hot-path performance --------------------- can ship independently
Phase 6 --- maintenance output caps ------------------ can ship independently
Phase 3B -- flip compact default --------------------- depends on Phase 3A + updated templates/docs
```

Phases 0, 1, 2, 5, 6 are independent and can ship in parallel PRs. Phase 3A depends on Phase 2 (quality gates must be in place before relying on summaries). Phase 3B is the coordinated default flip. Phase 4 builds on 3A.

## Open questions

1. **Bootstrap capsule implementation**: Should this be a new `knowledge-overview mode=compact` param, a new tool, or part of the Pi plugin's `before_agent_start`? Depends on which clients have runtime hooks.
2. **Strict conformance opt-in**: Should `store.strictConformance` reject or warn+store? Current plan: warn+store with opt-in rejection.
3. **Vault repair scope**: Should `knowledge-maintain repair` handle snapshot-lifecycle notes? Current plan: exempt snapshots from content mutation per project boundary "Never auto-modify stored content beyond what the caller explicitly requested."
4. **Vector search at scale**: At what note count should we invest in sqlite-vss or HNSW? Current plan: scope with SQL first (Phase 5), benchmark, then decide.
