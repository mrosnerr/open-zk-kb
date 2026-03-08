#!/bin/bash
set -euo pipefail

PASS=0
FAIL=0
TESTS=()

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); TESTS+=("PASS: $1"); }
fail() { echo "  ❌ $1: $2"; FAIL=$((FAIL + 1)); TESTS+=("FAIL: $1 — $2"); }

echo "═══════════════════════════════════════════"
echo "  open-zk-kb Docker Smoke Test"
echo "═══════════════════════════════════════════"
echo ""

# ─── 1. Build verification ───
echo "▸ Build Verification"

for FILE in dist/mcp-server.js dist/opencode-plugin.js dist/setup.js; do
  if [ -f "$FILE" ]; then
    pass "$FILE exists"
  else
    fail "$FILE exists" "file not found"
  fi
done
echo ""

# ─── 2. Unit tests ───
echo "▸ Unit Tests"

TEST_OUTPUT=$(bun test 2>&1)
if echo "$TEST_OUTPUT" | grep -qE "^\s*0 fail$"; then
  PASS_COUNT=$(echo "$TEST_OUTPUT" | grep -oE "[0-9]+ pass" | head -1)
  pass "all unit tests pass ($PASS_COUNT)"
else
  FAIL_LINE=$(echo "$TEST_OUTPUT" | grep "fail" | head -1)
  fail "unit tests" "$FAIL_LINE"
fi
echo ""

# ─── 3. Lint ───
echo "▸ Lint"

LINT_OUTPUT=$(bun run lint 2>&1)
LINT_SUMMARY=$(echo "$LINT_OUTPUT" | grep -oE "[0-9]+ error" | head -1 || true)
if [ -z "$LINT_SUMMARY" ] || echo "$LINT_SUMMARY" | grep -q "^0 error"; then
  pass "zero lint errors"
else
  fail "lint" "$LINT_SUMMARY"
fi
echo ""

# ─── 4. Install dry-run for ALL clients ───
echo "▸ Install Dry-Run (all clients)"

for CLIENT in opencode claude-code cursor windsurf zed; do
  OUTPUT=$(bun run src/setup.ts install --client "$CLIENT" --dry-run --force 2>&1 || true)
  if echo "$OUTPUT" | grep -q "Dry run: Would add to"; then
    pass "install --client $CLIENT --dry-run"
  else
    fail "install --client $CLIENT --dry-run" "unexpected output: $(echo "$OUTPUT" | head -1)"
  fi
done
echo ""

# ─── 5. Actual install for ALL clients ───
echo "▸ Actual Install (all clients)"

declare -A CLIENT_CONFIG_PATHS
CLIENT_CONFIG_PATHS=(
  [opencode]="$HOME/.config/opencode/opencode.json"
  [claude-code]="$HOME/.claude/settings.json"
  [cursor]="$HOME/.cursor/mcp.json"
  [windsurf]="$HOME/.codeium/windsurf/mcp_config.json"
  [zed]="$HOME/.config/zed/settings.json"
)

declare -A CLIENT_NAMES
CLIENT_NAMES=(
  [opencode]="OpenCode"
  [claude-code]="Claude Code"
  [cursor]="Cursor"
  [windsurf]="Windsurf"
  [zed]="Zed"
)

for CLIENT in opencode claude-code cursor windsurf zed; do
  NAME="${CLIENT_NAMES[$CLIENT]}"
  CONFIG_PATH="${CLIENT_CONFIG_PATHS[$CLIENT]}"

  OUTPUT=$(bun run src/setup.ts install --client "$CLIENT" --force 2>&1 || true)
  if echo "$OUTPUT" | grep -q "Installed open-zk-kb for $NAME"; then
    pass "install $CLIENT"
  else
    fail "install $CLIENT" "$(echo "$OUTPUT" | head -1)"
  fi

  # Verify config file was created with correct entry
  if [ -f "$CONFIG_PATH" ]; then
    if cat "$CONFIG_PATH" | grep -q "open-zk-kb"; then
      pass "$CLIENT config contains open-zk-kb entry"
    else
      fail "$CLIENT config" "missing open-zk-kb entry"
    fi
  else
    fail "$CLIENT config" "file not created at $CONFIG_PATH"
  fi
done

# Verify vault directory was created (shared across all clients)
VAULT_PATH="$HOME/.local/share/open-zk-kb"
if [ -d "$VAULT_PATH" ]; then
  pass "vault directory created"
else
  fail "vault directory" "not created at $VAULT_PATH"
fi

if [ -d "$VAULT_PATH/.index" ]; then
  pass "vault .index directory created"
else
  fail "vault .index" "not created"
fi
echo ""

# ─── 6. Idempotent install (all clients) ───
echo "▸ Idempotent Install (all clients)"

for CLIENT in opencode claude-code cursor windsurf zed; do
  NAME="${CLIENT_NAMES[$CLIENT]}"

  OUTPUT=$(bun run src/setup.ts install --client "$CLIENT" 2>&1 || true)
  if echo "$OUTPUT" | grep -q "Already installed"; then
    pass "$CLIENT idempotent install blocked"
  else
    fail "$CLIENT idempotent install" "should say Already installed"
  fi

  OUTPUT=$(bun run src/setup.ts install --client "$CLIENT" --force 2>&1 || true)
  if echo "$OUTPUT" | grep -q "Installed open-zk-kb for $NAME"; then
    pass "$CLIENT force install succeeds"
  else
    fail "$CLIENT force install" "$(echo "$OUTPUT" | head -1)"
  fi
done
echo ""

# ─── 7. Config copy (opencode client) ───
echo "▸ Config Copy (OpenCode)"

CONFIG_YAML="$HOME/.config/open-zk-kb/config.yaml"
EXAMPLE_CONFIG="config.example.yaml"
if [ -f "$CONFIG_YAML" ]; then
  pass "config.yaml exists at ~/.config/open-zk-kb/"
  if grep -q "opencode:" "$CONFIG_YAML"; then
    pass "config.yaml contains opencode section"
  elif grep -q "opencode:" "$EXAMPLE_CONFIG" 2>/dev/null; then
    pass "config.yaml pre-existed (opencode section in example config verified)"
  else
    fail "config.yaml content" "missing opencode section in both config and example"
  fi
else
  fail "config.yaml copy" "not found at $CONFIG_YAML"
fi
echo ""

# ─── 8. MCP server protocol + KB round-trip ───
echo "▸ MCP Server Protocol + KB Round-Trip"

# Use a clean temporary vault to avoid state pollution from previous runs
MCP_VAULT_DIR=$(mktemp -d)
MCP_OUTPUT=$(XDG_DATA_HOME="$MCP_VAULT_DIR" timeout 20 bun run tests/docker/mcp-protocol-test.ts 2>/dev/null || true)
rm -rf "$MCP_VAULT_DIR"
echo "$MCP_OUTPUT" | grep -E "^  [✅❌]" || true

MCP_RESULT=$(echo "$MCP_OUTPUT" | grep "MCP_RESULT" || echo "MCP_RESULT:0:4")
MCP_PASS=$(echo "$MCP_RESULT" | cut -d: -f2)
MCP_FAIL=$(echo "$MCP_RESULT" | cut -d: -f3)
PASS=$((PASS + MCP_PASS))
FAIL=$((FAIL + MCP_FAIL))
if [ "$MCP_FAIL" -gt 0 ]; then
  TESTS+=("FAIL: MCP protocol tests — $MCP_FAIL failures")
fi
echo ""

# ─── 9. Uninstall ALL clients ───
echo "▸ Uninstall (all clients)"

for CLIENT in opencode claude-code cursor windsurf zed; do
  NAME="${CLIENT_NAMES[$CLIENT]}"
  CONFIG_PATH="${CLIENT_CONFIG_PATHS[$CLIENT]}"

  OUTPUT=$(bun run src/setup.ts uninstall --client "$CLIENT" 2>&1 || true)
  if echo "$OUTPUT" | grep -q "Uninstalled"; then
    pass "uninstall $CLIENT"
  else
    fail "uninstall $CLIENT" "$(echo "$OUTPUT" | head -1)"
  fi

  # Verify config entry was removed
  if [ -f "$CONFIG_PATH" ]; then
    if ! cat "$CONFIG_PATH" | grep -q "open-zk-kb"; then
      pass "$CLIENT config entry removed"
    else
      fail "$CLIENT config cleanup" "open-zk-kb entry still present"
    fi
  else
    # Config file removed entirely is also acceptable
    pass "$CLIENT config entry removed (file cleaned up)"
  fi
done

# Vault should be preserved after uninstall (no --remove-vault flag)
if [ -d "$VAULT_PATH" ]; then
  pass "vault preserved after uninstall"
else
  fail "vault preservation" "vault was deleted without --remove-vault"
fi
echo ""

# ─── 10. Uninstall with --remove-vault ───
echo "▸ Uninstall with --remove-vault"

# Re-install one client so we can test vault removal
bun run src/setup.ts install --client cursor >/dev/null 2>&1 || true

OUTPUT=$(bun run src/setup.ts uninstall --client cursor --remove-vault --confirm 2>&1 || true)
if echo "$OUTPUT" | grep -q "Uninstalled"; then
  pass "uninstall with --remove-vault"
else
  fail "uninstall with --remove-vault" "$(echo "$OUTPUT" | head -1)"
fi

if [ ! -d "$VAULT_PATH" ]; then
  pass "vault deleted with --remove-vault"
else
  fail "vault deletion" "vault still exists after --remove-vault --confirm"
fi
echo ""

# ─── 11. Re-install after vault removal ───
echo "▸ Re-install After Vault Removal"

OUTPUT=$(bun run src/setup.ts install --client cursor 2>&1 || true)
if echo "$OUTPUT" | grep -q "Installed open-zk-kb for Cursor"; then
  pass "re-install after vault removal"
else
  fail "re-install after vault removal" "$(echo "$OUTPUT" | head -1)"
fi

if [ -d "$VAULT_PATH" ]; then
  pass "vault re-created on install"
else
  fail "vault re-creation" "vault not created on fresh install"
fi

if [ -d "$VAULT_PATH/.index" ]; then
  pass ".index re-created on install"
else
  fail ".index re-creation" "not created on fresh install"
fi
echo ""

# ─── 12. Double uninstall (already removed client) ───
echo "▸ Double Uninstall (idempotent)"

bun run src/setup.ts uninstall --client cursor >/dev/null 2>&1 || true
OUTPUT=$(bun run src/setup.ts uninstall --client cursor 2>&1 || true)
if echo "$OUTPUT" | grep -qi "not configured\|not found\|already"; then
  pass "double uninstall handled gracefully"
else
  fail "double uninstall" "unexpected output: $(echo "$OUTPUT" | head -1)"
fi
echo ""

# ─── 13. Pre-existing config preservation (merge, not clobber) ───
echo "▸ Config Merge (pre-existing servers preserved)"

for CLIENT in opencode claude-code cursor windsurf zed; do
  CONFIG_PATH="${CLIENT_CONFIG_PATHS[$CLIENT]}"

  bun run src/setup.ts uninstall --client "$CLIENT" >/dev/null 2>&1 || true

  mkdir -p "$(dirname "$CONFIG_PATH")"
  if [ "$CLIENT" = "opencode" ]; then
    echo '{"mcp":{"other-server":{"type":"local","command":["node","other.js"],"enabled":true}}}' > "$CONFIG_PATH"
  elif [ "$CLIENT" = "zed" ]; then
    echo '{"context_servers":{"other-server":{"command":"node","args":["other.js"]}}}' > "$CONFIG_PATH"
  else
    echo '{"mcpServers":{"other-server":{"command":"node","args":["other.js"]}}}' > "$CONFIG_PATH"
  fi

  bun run src/setup.ts install --client "$CLIENT" --force 2>&1 >/dev/null || true

  if cat "$CONFIG_PATH" | grep -q "other-server"; then
    pass "$CLIENT preserves existing servers"
  else
    fail "$CLIENT config merge" "other-server entry was clobbered"
  fi

  if cat "$CONFIG_PATH" | grep -q "open-zk-kb"; then
    pass "$CLIENT adds open-zk-kb alongside existing"
  else
    fail "$CLIENT config merge" "open-zk-kb entry not added"
  fi

  bun run src/setup.ts uninstall --client "$CLIENT" >/dev/null 2>&1 || true

  if cat "$CONFIG_PATH" | grep -q "other-server"; then
    pass "$CLIENT uninstall preserves other servers"
  else
    fail "$CLIENT uninstall merge" "other-server removed during uninstall"
  fi
done
echo ""

# ─── 14. Malformed/empty config handling ───
echo "▸ Malformed Config Handling"

for CLIENT in cursor windsurf; do
  CONFIG_PATH="${CLIENT_CONFIG_PATHS[$CLIENT]}"
  mkdir -p "$(dirname "$CONFIG_PATH")"

  echo "" > "$CONFIG_PATH"
  OUTPUT=$(bun run src/setup.ts install --client "$CLIENT" 2>&1 || true)
  if echo "$OUTPUT" | grep -qi "failed to parse\|error\|Installed"; then
    pass "$CLIENT empty config handled (error or recovery)"
  else
    fail "$CLIENT empty config" "unexpected: $(echo "$OUTPUT" | head -1)"
  fi

  echo "not json at all {{{" > "$CONFIG_PATH"
  OUTPUT=$(bun run src/setup.ts install --client "$CLIENT" 2>&1 || true)
  if echo "$OUTPUT" | grep -qi "failed to parse\|error"; then
    pass "$CLIENT corrupt config gives clear error"
  else
    fail "$CLIENT corrupt config" "no error shown: $(echo "$OUTPUT" | head -1)"
  fi

  rm -f "$CONFIG_PATH"
done
echo ""

# ─── 15. README JSON examples are valid ───
echo "▸ README JSON Validation"

BLOCK_COUNT=0
BLOCK_VALID=0

bun -e "
  const fs = require('fs');
  const readme = fs.readFileSync('README.md', 'utf-8');
  const blocks = [...readme.matchAll(/\`\`\`json\n([\s\S]*?)\n\`\`\`/g)].map(m => m[1]);
  let valid = 0;
  for (const block of blocks) {
    try { JSON.parse(block); valid++; } catch {}
  }
  console.log(blocks.length + ':' + valid);
" 2>/dev/null > /tmp/json-check.txt || echo "0:0" > /tmp/json-check.txt

BLOCK_COUNT=$(cut -d: -f1 /tmp/json-check.txt)
BLOCK_VALID=$(cut -d: -f2 /tmp/json-check.txt)

if [ "$BLOCK_COUNT" -gt 0 ] && [ "$BLOCK_COUNT" -eq "$BLOCK_VALID" ]; then
  pass "all $BLOCK_COUNT README JSON blocks are valid"
else
  fail "README JSON" "$BLOCK_VALID/$BLOCK_COUNT blocks valid"
fi
echo ""

# ─── 16. MCP server works without pre-existing vault ───
echo "▸ MCP Server Fresh Start (no vault)"

rm -rf "$VAULT_PATH"

FRESH_OUTPUT=$(timeout 15 bun run tests/docker/mcp-protocol-test.ts 2>/dev/null || true)
if echo "$FRESH_OUTPUT" | grep -q "knowledge-store creates note"; then
  pass "MCP server creates vault on first use"
else
  if echo "$FRESH_OUTPUT" | grep -q "MCP initialize response"; then
    pass "MCP server starts without vault"
  else
    fail "MCP server fresh start" "server failed without vault"
  fi
fi

if [ -d "$VAULT_PATH" ] || [ -d "$HOME/.local/share/open-zk-kb" ]; then
  pass "vault auto-created by server"
else
  fail "vault auto-creation" "vault not created after server use"
fi
echo ""

# ─── 17. Install with existing vault (pre-existing notes) ───
echo "▸ Install with Existing Vault"

for CLIENT in opencode claude-code cursor windsurf zed; do
  bun run src/setup.ts uninstall --client "$CLIENT" >/dev/null 2>&1 || true
done

rm -rf "$VAULT_PATH"
mkdir -p "$VAULT_PATH/.index"

cat > "$VAULT_PATH/202501011200-existing-decision.md" << 'NOTE'
---
title: Existing Decision
kind: decision
status: permanent
tags:
  - architecture
created: 2025-01-01T12:00:00.000Z
---

We decided to use PostgreSQL for the primary database.
NOTE

cat > "$VAULT_PATH/202501021200-existing-preference.md" << 'NOTE'
---
title: Existing Preference
kind: personalization
status: permanent
tags:
  - ui
created: 2025-01-02T12:00:00.000Z
---

User prefers dark mode in all editors.
NOTE

NOTE_COUNT=$(ls "$VAULT_PATH"/*.md 2>/dev/null | wc -l | tr -d ' ')
if [ "$NOTE_COUNT" -eq 2 ]; then
  pass "pre-existing vault has 2 notes"
else
  fail "pre-existing vault setup" "expected 2 notes, got $NOTE_COUNT"
fi

bun run src/setup.ts install --client cursor >/dev/null 2>&1 || true

POST_COUNT=$(ls "$VAULT_PATH"/*.md 2>/dev/null | wc -l | tr -d ' ')
if [ "$POST_COUNT" -eq 2 ]; then
  pass "install preserves existing notes"
else
  fail "install note preservation" "expected 2 notes, got $POST_COUNT"
fi

EXISTING_OUTPUT=$(timeout 15 bun -e "
  import { Client } from '@modelcontextprotocol/sdk/client/index.js';
  import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

  const transport = new StdioClientTransport({ command: 'bun', args: ['dist/mcp-server.js'] });
  const client = new Client({ name: 'vault-test', version: '1.0' });
  await client.connect(transport);

  const rebuild = await client.callTool({ name: 'knowledge-maintain', arguments: { action: 'rebuild' } });
  const rebuildText = JSON.stringify(rebuild);

  const search = await client.callTool({ name: 'knowledge-search', arguments: { query: 'PostgreSQL database' } });
  const searchText = JSON.stringify(search);

  const stats = await client.callTool({ name: 'knowledge-maintain', arguments: { action: 'stats' } });
  const statsText = JSON.stringify(stats);

  await client.close();
  console.log('REBUILD:' + (rebuildText.toLowerCase().includes('indexed') ? 'ok' : 'fail'));
  console.log('SEARCH:' + (searchText.includes('PostgreSQL') || searchText.includes('Existing Decision') ? 'ok' : 'fail'));
  console.log('STATS:' + statsText);
" 2>/dev/null || echo "REBUILD:fail")

if echo "$EXISTING_OUTPUT" | grep -q "REBUILD:ok"; then
  pass "rebuild indexes existing vault files"
else
  fail "rebuild" "failed to index existing files"
fi

if echo "$EXISTING_OUTPUT" | grep -q "SEARCH:ok"; then
  pass "search finds pre-existing notes"
else
  fail "search pre-existing" "could not find existing notes"
fi

bun run src/setup.ts uninstall --client cursor >/dev/null 2>&1 || true
echo ""

# ─── 18. npm pack produces valid package ───
echo "▸ npm pack Validation"

PACK_OUTPUT=$(bun pm pack 2>&1 || npm pack 2>&1 || true)
TARBALL=$(ls -t open-zk-kb-*.tgz 2>/dev/null | head -1)

if [ -n "$TARBALL" ] && [ -f "$TARBALL" ]; then
  pass "npm pack creates tarball"

  PACK_FILES=$(tar tzf "$TARBALL")

  for REQUIRED in package/dist/mcp-server.js package/dist/setup.js package/dist/opencode-plugin.js package/package.json package/README.md; do
    if echo "$PACK_FILES" | grep -q "$REQUIRED"; then
      pass "tarball contains $REQUIRED"
    else
      fail "tarball contents" "missing $REQUIRED"
    fi
  done

  PACK_DIR=$(mktemp -d)
  mkdir -p "$PACK_DIR/test-install"
  cp "$TARBALL" "$PACK_DIR/test-install/"

  (
    cd "$PACK_DIR/test-install"
    echo '{"dependencies":{"open-zk-kb":"file:./'"$TARBALL"'"}}' > package.json
    bun install 2>&1 >/dev/null
  )

  BIN_PATH="$PACK_DIR/test-install/node_modules/.bin/open-zk-kb-server"
  if [ -f "$BIN_PATH" ] || [ -L "$BIN_PATH" ]; then
    pass "open-zk-kb-server bin symlink created"
  else
    fail "bin symlink" "open-zk-kb-server not found in node_modules/.bin/"
  fi

  BIN_SETUP="$PACK_DIR/test-install/node_modules/.bin/open-zk-kb"
  if [ -f "$BIN_SETUP" ] || [ -L "$BIN_SETUP" ]; then
    pass "open-zk-kb bin symlink created"
  else
    fail "bin symlink" "open-zk-kb not found in node_modules/.bin/"
  fi

  rm -rf "$PACK_DIR"
  rm -f "$TARBALL"
else
  fail "npm pack" "no tarball created"
fi
echo ""

# ─── 19. CLI entry points respond ───
echo "▸ CLI Entry Points"

OUTPUT=$(timeout 5 bun dist/setup.js --help 2>&1 || true)
if echo "$OUTPUT" | grep -qi "install\|uninstall\|usage"; then
  pass "open-zk-kb --help works"
else
  fail "open-zk-kb --help" "no help output: $(echo "$OUTPUT" | head -1)"
fi

OUTPUT=$(timeout 5 bun dist/setup.js install --client cursor --dry-run 2>&1 || true)
if echo "$OUTPUT" | grep -q "Dry run"; then
  pass "open-zk-kb install via dist/setup.js"
else
  fail "CLI install" "$(echo "$OUTPUT" | head -1)"
fi
echo ""

# ─── Summary ───
echo "═══════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "Failures:"
  for t in "${TESTS[@]}"; do
    if [[ "$t" == FAIL* ]]; then
      echo "  $t"
    fi
  done
  exit 1
fi

echo ""
echo "All smoke tests passed! ✅"
