# Setup Guide

This guide covers installation for all supported clients. For configuration details, see [configuration.md](configuration.md).

## Prerequisites
- [Bun](https://bun.sh) >= 1.0.0 (required — uses `bun:sqlite` for storage)
  - Verify: `bun --version` should return 1.x.x

## Install from npm (recommended)

Run the interactive installer:
```bash
bunx open-zk-kb@latest
```

This presents a multi-select prompt — use Space to select clients, Enter to confirm. Supported clients: OpenCode, Claude Code, Cursor, Windsurf.

> **Note**: The installer automatically copies `config.example.yaml` to `~/.config/open-zk-kb/config.yaml` if no config file exists yet. Local embeddings (MiniLM, 23MB) are enabled by default and require no API key.

### Manual Installation (for any MCP client)

Add to your client's MCP configuration — no cloning required:
```json
{
  "open-zk-kb": {
    "command": "bunx",
    "args": ["open-zk-kb-server"]
  }
}
```
For OpenCode, use the `mcp` key with `"type": "local"` and `"command": ["bunx", "open-zk-kb-server"]`.

## Install from source (for development)

```bash
git clone https://github.com/mrosnerr/open-zk-kb
cd open-zk-kb
bun install
bun run build
bun run setup            # interactive installer
```

Verification: `ls dist/mcp-server.js` should exist.

For scripted/CI use:
```bash
bun run setup install --client opencode
```

### Config file locations

| Client | Config path |
|--------|-------------|
| OpenCode | `~/.config/opencode/opencode.json` |
| Claude Code | `~/.claude/settings.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

## Verify Installation
1. Restart your editor/client.
2. Ask your assistant: **"Run `knowledge-maintain stats`"**
3. You should see vault statistics (0 notes on fresh install). This confirms the 3 tools are available:
   - `knowledge-store` -- save notes to the knowledge base
   - `knowledge-search` -- full-text search across notes
   - `knowledge-maintain` -- stats, review, promote, archive, rebuild

## Instruction Injection

During installation, open-zk-kb automatically injects knowledge base instructions into your client's global instruction file:

| Client | Instruction File |
|--------|-----------------|
| OpenCode | `~/.config/opencode/AGENTS.md` |
| Claude Code | `~/.claude/CLAUDE.md` |
| Cursor | `~/.cursor/rules/open-zk-kb.mdc` |
| Windsurf | `~/.windsurf/rules/open-zk-kb.md` |

The injected block is wrapped in managed markers:
```
<!-- OPEN-ZK-KB:START -- managed by open-zk-kb, do not edit -->
...instructions...
<!-- OPEN-ZK-KB:END -->
```

**Safe to edit**: You can freely add your own content outside the managed markers. Re-running the installer updates only the content between markers.

**Upgrade**: Running `bunx open-zk-kb@latest install --client <name> --force` updates the instructions to the latest version without touching your other content.

**Uninstall**: Running `bunx open-zk-kb@latest uninstall --client <name>` removes the managed block from the instruction file.

## Optional Configuration
- **All settings** are in `~/.config/open-zk-kb/config.yaml`. Customize vault path, log level, lifecycle review thresholds, and vector embeddings in a single file. See [configuration.md](configuration.md).

## Uninstalling

Interactive (npm):
```bash
bunx open-zk-kb@latest uninstall
```

Or for a specific client:
```bash
bunx open-zk-kb@latest uninstall --client opencode
```

From source:
```bash
bun run setup uninstall --client opencode
```

This removes the MCP server entry from the client config. Your notes in the vault are NOT deleted.

To also remove the vault (irreversible):
```bash
bunx open-zk-kb@latest uninstall --client opencode --remove-vault --confirm
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "command not found: bun" | Install Bun: `curl -fsSL https://bun.sh/install \| bash` |
| "open-zk-kb requires the Bun runtime" | You ran with Node.js/npx. Use `bunx` instead of `npx`. |
| Tools don't appear after install | Restart your editor. Check client config file was modified. |
| MCP connection errors | Check logs at `~/.local/state/open-zk-kb/logs/`. |
| "database is locked" errors | Another instance may be running. Check for duplicate MCP server entries in your client config. |
| Dry run first | Add `--dry-run` to any setup command to preview changes without applying them |

## For AI Agents -- Integration Checklist
This section is specifically for AI coding assistants setting up open-zk-kb:
1. Run `bun --version` -- confirm >= 1.0.0 (if missing: `curl -fsSL https://bun.sh/install | bash`)
2. Run `bunx open-zk-kb@latest install --client <detected-client>`
3. Instruct user to restart their editor
4. Verify by calling `knowledge-maintain stats`
5. Knowledge capture is driven by `AGENTS.md` or `CLAUDE.md` instructions provided during setup. Calling models use `knowledge-store` directly.
