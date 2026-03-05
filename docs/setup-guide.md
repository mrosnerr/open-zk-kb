# Setup Guide

This guide covers installation for all supported clients. For configuration details, see [configuration.md](configuration.md).

## Prerequisites
- Bun >= 1.0.0 -- install from https://bun.sh if not present
  - Verify: `bun --version` should return 1.x.x
- Git

## Step 1: Clone and Build
```bash
git clone https://github.com/open-zk-kb/open-zk-kb
cd open-zk-kb
bun install
bun run build
```
Verification: `ls dist/mcp-server.js` should exist.

## Step 2: Install for Your Client

> **Note**: The installer automatically copies `config.example.yaml` to `~/.config/open-zk-kb/config.yaml` if no config file exists yet. You only need to edit it if you're using OpenCode plugin features.

### a) OpenCode (enhanced plugin with auto-capture):
```bash
bun run setup install --client opencode
```
Config file location: `~/.config/opencode/opencode.json`

The installer creates `~/.config/open-zk-kb/config.yaml` automatically. Edit it to add your API provider details for auto-capture and embeddings:
```bash
# Edit the auto-generated config with your API key
nano ~/.config/open-zk-kb/config.yaml
```

### b) Claude Code:
```bash
bun run setup install --client claude-code
```
Config file location: `~/.claude/settings.json`
No additional config needed for basic usage.

### c) Cursor:
```bash
bun run setup install --client cursor
```
Config file location: `~/.config/cursor/mcp.json`
No additional config needed for basic usage.

### d) Windsurf:
```bash
bun run setup install --client windsurf
```
Config file location: `~/.config/windsurf/mcp.json`
No additional config needed for basic usage.

### e) Zed:
```bash
bun run setup install --client zed
```
Config file location: `~/.config/zed/settings.json`
No additional config needed for basic usage.

### Manual Installation (for any MCP client):
Add to your client's MCP configuration:
```json
{
  "open-zk-kb": {
    "command": "bun",
    "args": ["run", "/absolute/path/to/open-zk-kb/dist/mcp-server.js"]
  }
}
```
Replace `/absolute/path/to/open-zk-kb` with the actual path where you cloned the repo.

## Step 3: Verify Installation
1. Restart your editor/client.
2. Ask your assistant: **"Run `knowledge-maintain stats`"**
3. You should see vault statistics (0 notes on fresh install). This confirms the 3 tools are available:
   - `knowledge-store` -- save notes to the knowledge base
   - `knowledge-search` -- full-text search across notes
   - `knowledge-maintain` -- stats, review, promote, archive, rebuild

If the tool isn't recognized, check that your client config file was updated (see paths above) and that `dist/mcp-server.js` exists.

## Step 4: Optional Configuration
- **All settings** are in `~/.config/open-zk-kb/config.yaml`. Customize vault path, log level, grooming thresholds, and OpenCode plugin features in a single file. See [configuration.md](configuration.md).

## Uninstalling
```bash
bun run setup uninstall --client <client-name>
```
This removes the MCP server entry from the client config. Your notes in the vault are NOT deleted.

To also remove the vault (irreversible):
```bash
bun run setup uninstall --client <client-name> --remove-vault --confirm
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
