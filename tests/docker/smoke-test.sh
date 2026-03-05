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

if [ -f dist/mcp-server.js ]; then
  pass "dist/mcp-server.js exists"
else
  fail "dist/mcp-server.js exists" "file not found"
fi

if [ -f dist/opencode-plugin.js ]; then
  pass "dist/opencode-plugin.js exists"
else
  fail "dist/opencode-plugin.js exists" "file not found"
fi

if [ -f dist/setup.js ]; then
  pass "dist/setup.js exists"
else
  fail "dist/setup.js exists" "file not found"
fi
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

# ─── 4. Install for each client (dry-run) ───
echo "▸ Install Dry-Run (all clients)"

for CLIENT in opencode claude-code cursor windsurf zed; do
  OUTPUT=$(bun run src/setup.ts install --client "$CLIENT" --dry-run 2>&1 || true)
  if echo "$OUTPUT" | grep -q "Dry run: Would add to"; then
    pass "install --client $CLIENT --dry-run"
  else
    fail "install --client $CLIENT --dry-run" "unexpected output: $(echo "$OUTPUT" | head -1)"
  fi
done
echo ""

# ─── 5. Actual install (cursor as test target) ───
echo "▸ Actual Install (cursor)"

OUTPUT=$(bun run src/setup.ts install --client cursor 2>&1 || true)
if echo "$OUTPUT" | grep -q "Installed open-zk-kb for Cursor"; then
  pass "install --client cursor"
else
  fail "install --client cursor" "$(echo "$OUTPUT" | head -1)"
fi

CONFIG_PATH="$HOME/.cursor/mcp.json"
if [ -f "$CONFIG_PATH" ]; then
  if cat "$CONFIG_PATH" | grep -q "open-zk-kb"; then
    pass "cursor config contains open-zk-kb entry"
  else
    fail "cursor config" "missing open-zk-kb entry"
  fi
else
  fail "cursor config" "file not created at $CONFIG_PATH"
fi

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

# ─── 6. Idempotent install ───
echo "▸ Idempotent Install"

OUTPUT=$(bun run src/setup.ts install --client cursor 2>&1 || true)
if echo "$OUTPUT" | grep -q "Already installed"; then
  pass "idempotent install blocked"
else
  fail "idempotent install" "should say Already installed"
fi

OUTPUT=$(bun run src/setup.ts install --client cursor --force 2>&1 || true)
if echo "$OUTPUT" | grep -q "Installed open-zk-kb for Cursor"; then
  pass "force install succeeds"
else
  fail "force install" "$(echo "$OUTPUT" | head -1)"
fi
echo ""

# ─── 7. Config copy (opencode client) ───
echo "▸ Config Copy (OpenCode)"

OUTPUT=$(bun run src/setup.ts install --client opencode 2>&1 || true)
CONFIG_YAML="$HOME/.config/open-zk-kb/config.yaml"
if [ -f "$CONFIG_YAML" ]; then
  pass "config.yaml copied to ~/.config/open-zk-kb/"
  if grep -q "opencode:" "$CONFIG_YAML"; then
    pass "config.yaml contains opencode section"
  else
    fail "config.yaml content" "missing opencode section"
  fi
else
  fail "config.yaml copy" "not found at $CONFIG_YAML"
fi
echo ""

# ─── 8. MCP server responds to initialize ───
echo "▸ MCP Server Protocol + KB Round-Trip"

MCP_OUTPUT=$(timeout 20 bun run tests/docker/mcp-protocol-test.ts 2>/dev/null || true)
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

# ─── 10. Uninstall ───
echo "▸ Uninstall"

OUTPUT=$(bun run src/setup.ts uninstall --client cursor 2>&1 || true)
if echo "$OUTPUT" | grep -q "Uninstalled"; then
  pass "uninstall --client cursor"
else
  fail "uninstall" "$(echo "$OUTPUT" | head -1)"
fi

if [ -f "$CONFIG_PATH" ]; then
  if ! cat "$CONFIG_PATH" | grep -q "open-zk-kb"; then
    pass "cursor config entry removed"
  else
    fail "cursor config cleanup" "open-zk-kb entry still present"
  fi
fi

if [ -d "$VAULT_PATH" ]; then
  pass "vault preserved after uninstall"
else
  fail "vault preservation" "vault was deleted without --remove-vault"
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
