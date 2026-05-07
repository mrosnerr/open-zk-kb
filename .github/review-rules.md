# OpenCode Review Rules

These rules guide the in-repo OpenCode reviewer for `open-zk-kb`.

## Review goals

- Find real bugs, regressions, and contract violations.
- Prefer a single comprehensive review over drip-feeding new findings across rounds.
- Focus on substance, not formatting or generic advice.
- Check changed files in the context of the full file, not just diff hunks.

## Severity tiers

Prefix every finding title with exactly one tier:

- **P0** — Critical. Blocks merge.
- **P1** — Important. Should fix before merge.
- **P2** — Minor. Take it or leave it.

### P0 examples

- Security vulnerabilities with a concrete exploit path
- Data loss or corruption
- MCP stdout pollution from server code logging
- Lifecycle enforcement gaps on snapshot or append-only notes
- Backward-incompatible contract breakage without migration/defaults

### P1 examples

- Logic bugs in realistic edge cases
- Missing error handling on I/O boundaries
- Missing regression tests for a bug fix
- Type safety violations such as `as any`, `@ts-ignore`, or `@ts-expect-error`
- Configuration mistakes likely to silently misroute settings

### P2 examples

- Small readability improvements
- Naming suggestions
- Documentation drift or wording improvements

Keep P2 output sparse. More than a couple P2 findings usually means the review is getting noisy.

## What to flag

- Real bugs with exact files, lines, and consequences
- Security issues involving SQLite/FTS5 input, filesystem paths, or config/workflow exposure
- Missing error handling on database, filesystem, fetch, or process boundaries
- Lifecycle violations for snapshot, append-only, or structural notes
- Dual-storage sync gaps between markdown files and SQLite index
- Workflow security issues in `.github/workflows/*.yml`
- Tests that fail to cover the behavior the PR claims to fix
- AGENTS.md or ownership-model violations introduced by the PR

## What not to flag

- Import order, formatting, or lint-only concerns
- Generic praise or filler
- Theoretical issues without a concrete failure path
- Suggestions to switch away from Bun APIs to Node.js APIs
- Refactors unrelated to the PR's purpose
- Unchanged code outside the PR, unless required to explain a new regression or missing test

## Project-specific rules

### R1. MCP stdout safety

When code changes `src/` (except `src/setup.ts` and CLI/scripts paths), verify there is no `console.log`, `console.warn`, or `console.error`. MCP stdio requires clean stdout. Use `logToFile()` instead.

### R2. Lifecycle enforcement

When code touches `NoteRepository`, schema logic, or tool handlers, verify:

- snapshot notes reject mutation
- append-only notes reject rewrites
- lifecycle violations are surfaced, not swallowed

### R3. Structural kind protection

When code touches note creation or maintenance flows, verify:

- `index` and `log` remain auto-generated only
- navigation hooks skip structural kinds where needed
- no recursion or self-trigger loops are introduced

### R4. Dual storage integrity

When note content or metadata changes, verify the markdown file and SQLite index stay in sync. Filesystem is the source of truth.

### R5. Config integrity

When code changes TOML, YAML, JSON, or config loading behavior, verify:

- new keys land in the intended section
- defaults exist where needed
- section shadowing or silent misconfiguration is not introduced

### R6. GitHub Actions security

When code changes `.github/workflows/*.yml`, verify:

- actions are pinned appropriately
- permissions are minimal
- secrets are not exposed to forks
- `pull_request_target` is not introduced unsafely

### R7. Ownership-model compliance

The server computes; the agent judges.

Flag code that makes the server:

- return directives instead of annotated data
- auto-modify stored content beyond caller intent
- shift agent-judgment work into deterministic server messaging

## Review checklist for this repo

- Read `AGENTS.md` for architecture, boundaries, and conventions.
- Check `.github/CONTRIBUTING.md` and PR template expectations where relevant.
- Read the full changed file for each touched path.
- Verify tests actually exercise the claimed behavior.
- Prefer exact, actionable findings over volume.

## Output guidance

- Use markdown.
- Group by severity.
- Include file paths and line references when possible.
- If the PR looks good, say so explicitly instead of inventing issues.
