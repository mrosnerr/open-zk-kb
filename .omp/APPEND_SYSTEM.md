# OMP Project Configuration

## Project Agent Resources

This project uses OMP-specific configuration in `.omp/`:

- **Rules** (`.omp/rules/`) — markdown rules with frontmatter controlling agent behavior. Always-apply rules render inline in the prompt; conditional rules use TTSR to interrupt mid-generation when the agent violates a pattern.
- **Hooks** (`.omp/hooks/`) — narrow lifecycle hooks for session, turn, and tool interception. `tool_call` hooks are fail-closed (can block execution).
- **Commands** (`.omp/commands/`) — custom slash commands (TypeScript modules).
- **Extensions** (`.agents/omp/extensions/`) — broad in-process extensions with provider access.

## Context Compaction

Long sessions trigger automatic compaction. To preserve important context across compaction:

- Capture decisions and observations in the knowledge base early — do not wait for session end
- Use `memory://` to reference persistent state that survives compaction
- Compaction cuts at turn boundaries, never mid-tool-result
- Large tool outputs are pruned before compaction decisions — keep tool results concise

## Internal URL Schemes

OMP resolves these URLs transparently in file-reading tools:

- `skill://<name>` — load skill instructions
- `rule://<name>` — load rule content
- `artifact://<id>` — recover full output from truncated tool results
- `memory://` — access session memory state
- `issue://<N>` / `pr://<N>` — GitHub issue/PR views (cached on disk)
- `local://<name>` — session-local shared files
- `mcp://<uri>` — MCP server resources
