# Setup Guide

This guide covers installation for all supported clients. For configuration details, see [configuration.md](configuration.md).

## Prerequisites
- Bun >= 1.0.0 -- install from https://bun.sh if not present
  - Verify: `bun --version` should return 1.x.x
- Git

## Step 1: Clone and Build
```bash
git clone https://github.com/mrosnerr/open-zk-kb
cd open-zk-kb
bun install
bun run build
```
Verification: `ls dist/mcp-server.js` should exist.

## Step 2: Install for Your Client

Run the interactive installer:
```bash
bun run setup
```

This presents a multi-select prompt — use Space to select clients, Enter to confirm. Supported clients: OpenCode, Claude Code, Cursor, Windsurf, Zed.

> **Note**: The installer automatically copies `config.example.yaml` to `~/.config/open-zk-kb/config.yaml` if no config file exists yet. You only need to edit it if you're using OpenCode plugin features.

For scripted/CI use, pass the client directly:
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
| Zed | `~/.config/zed/settings.json` |

### OpenCode: additional setup

If using OpenCode, edit the auto-generated config with your API key:
```bash
nano ~/.config/open-zk-kb/config.yaml
```

### Manual Installation (for any MCP client):
Add to your client's MCP configuration (no cloning required):
```json
{
  "open-zk-kb": {
    "command": "bunx",
    "args": ["open-zk-kb-server"]
  }
}
```
For Zed, use `context_servers` instead of `mcpServers`. For OpenCode, use the `mcp` key with `"type": "local"` and `"command": ["bunx", "open-zk-kb-server"]`.

## Step 3: Verify Installation
1. Restart your editor/client.
2. Ask your assistant: **"Run `knowledge-maintain stats`"**
3. You should see vault statistics (0 notes on fresh install). This confirms the 3 tools are available:
   - `knowledge-store` -- save notes to the knowledge base
   - `knowledge-search` -- full-text search across notes
   - `knowledge-maintain` -- stats, review, promote, archive, rebuild

If the tool isn't recognized, check that your client config file was updated (see paths above) and that `dist/mcp-server.js` exists.

## Step 4: Optional Configuration
- **All settings** are in `~/.config/open-zk-kb/config.yaml`. Customize vault path, log level, lifecycle review thresholds, and OpenCode plugin features in a single file. See [configuration.md](configuration.md).

## Uninstalling

Interactive:
```bash
bun run setup uninstall
```

Or for a specific client:
```bash
bun run setup uninstall --client opencode
```

This removes the MCP server entry from the client config. Your notes in the vault are NOT deleted.

To also remove the vault (irreversible):
```bash
bun run setup uninstall --client opencode --remove-vault --confirm
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "command not found: bun" | Install Bun: `curl -fsSL https://bun.sh/install \| bash` |
| Tools don't appear after install | Restart your editor. Check client config file was modified. |
| "Could not detect server path" | Run from the open-zk-kb directory, or pass `--server-path /path/to/dist/mcp-server.js` |
| MCP connection errors | Verify `dist/mcp-server.js` exists (`bun run build` if not). Check logs at `~/.local/state/open-zk-kb/logs/`. |
| "database is locked" errors | Another instance may be running. Check for duplicate MCP server entries in your client config. |
| Dry run first | Add `--dry-run` to any setup command to preview changes without applying them |

## For AI Agents -- Integration Checklist
This section is specifically for AI coding assistants setting up open-zk-kb:
1. Run `bun --version` -- confirm >= 1.0.0
2. Clone repo, run `bun install && bun run build`
3. Run `bun run setup install --client <detected-client>` 
4. Instruct user to restart their editor
5. Verify by calling `knowledge-maintain stats`
6. If OpenCode: remind user to copy `config.example.yaml` to `~/.config/open-zk-kb/config.yaml` with their API key
