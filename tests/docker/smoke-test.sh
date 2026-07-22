#!/bin/bash
set -euo pipefail

# This suite intentionally exercises destructive install/uninstall paths. Isolate
# every user-writable location before running any command so a host invocation
# cannot touch the caller's real vault or client configuration.
SMOKE_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SMOKE_REPO_ROOT=$(CDPATH= cd -- "$SMOKE_SCRIPT_DIR/../.." && pwd -P)
SMOKE_ORIGINAL_HOME=${HOME:-}
SMOKE_ORIGINAL_XDG_DATA_HOME=${XDG_DATA_HOME:-}

# The destructive suite is supported only on an explicitly disposable runner
# (CI or a container). Unit tests may invoke the lightweight sandbox verifier.
if [ "${1:-}" != "--verify-sandbox" ] \
  && [ "${OPEN_ZK_KB_EPHEMERAL_SMOKE:-}" != "1" ]; then
  echo "REFUSING TO RUN destructive smoke tests on an unmarked host." >&2
  echo "Run the documented Docker command instead." >&2
  exit 1
fi

SMOKE_SANDBOX_MARKER="open-zk-kb destructive smoke-test sandbox"
SMOKE_SANDBOX_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/open-zk-kb-smoke.XXXXXX")
SMOKE_SANDBOX_ROOT=$(CDPATH= cd -- "$SMOKE_SANDBOX_ROOT" && pwd -P)

# Refuse even temporary sandbox creation below inherited user-data roots. This
# catches hostile or surprising TMPDIR values before the suite writes anything.
for SMOKE_PROTECTED_ROOT in "$SMOKE_ORIGINAL_HOME" "$SMOKE_ORIGINAL_XDG_DATA_HOME"; do
  if [ -n "$SMOKE_PROTECTED_ROOT" ] && [ -d "$SMOKE_PROTECTED_ROOT" ]; then
    SMOKE_PROTECTED_ROOT=$(CDPATH= cd -- "$SMOKE_PROTECTED_ROOT" && pwd -P)
    case "$SMOKE_SANDBOX_ROOT" in
      "$SMOKE_PROTECTED_ROOT"|"$SMOKE_PROTECTED_ROOT"/*)
        rmdir "$SMOKE_SANDBOX_ROOT"
        echo "REFUSING TO RUN: smoke sandbox resolved inside user data: $SMOKE_PROTECTED_ROOT" >&2
        exit 1
        ;;
    esac
  fi
done

SMOKE_SANDBOX_SENTINEL="$SMOKE_SANDBOX_ROOT/.open-zk-kb-smoke-sandbox"
chmod 700 "$SMOKE_SANDBOX_ROOT"
printf '%s\n' "$SMOKE_SANDBOX_MARKER" > "$SMOKE_SANDBOX_SENTINEL"

smoke_canonical_path() {
  local target=$1
  local parent base
  if [ -d "$target" ]; then
    (CDPATH= cd -P -- "$target" && pwd -P)
    return
  fi
  parent=$(dirname -- "$target")
  base=$(basename -- "$target")
  parent=$(CDPATH= cd -P -- "$parent" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "$parent" "$base"
}

smoke_assert_sandbox_path() {
  local target=$1
  local allow_root=${2:-false}
  local resolved

  if [ ! -f "$SMOKE_SANDBOX_SENTINEL" ] \
    || [ "$(cat "$SMOKE_SANDBOX_SENTINEL")" != "$SMOKE_SANDBOX_MARKER" ]; then
    echo "REFUSING DELETION: smoke-test sandbox sentinel is missing or invalid" >&2
    return 1
  fi

  resolved=$(smoke_canonical_path "$target") || {
    echo "REFUSING DELETION: cannot resolve $target" >&2
    return 1
  }

  if [ "$resolved" = "$SMOKE_SANDBOX_ROOT" ]; then
    if [ "$allow_root" = "true" ]; then
      return 0
    fi
    echo "REFUSING DELETION: sandbox root requires cleanup authorization" >&2
    return 1
  fi

  case "$resolved" in
    "$SMOKE_SANDBOX_ROOT"/*) return 0 ;;
    *)
      echo "REFUSING DELETION OUTSIDE SMOKE SANDBOX: $resolved" >&2
      return 1
      ;;
  esac
}

smoke_rm_rf() {
  local target
  for target in "$@"; do
    smoke_assert_sandbox_path "$target" || return 1
    rm -rf -- "$target"
  done
}

smoke_cleanup() {
  if [ -d "$SMOKE_SANDBOX_ROOT" ]; then
    smoke_assert_sandbox_path "$SMOKE_SANDBOX_ROOT" true || return
    rm -rf -- "$SMOKE_SANDBOX_ROOT"
  fi
}
trap smoke_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p \
  "$SMOKE_SANDBOX_ROOT/home" \
  "$SMOKE_SANDBOX_ROOT/home/.config" \
  "$SMOKE_SANDBOX_ROOT/home/.local/share" \
  "$SMOKE_SANDBOX_ROOT/home/.local/state" \
  "$SMOKE_SANDBOX_ROOT/home/.cache" \
  "$SMOKE_SANDBOX_ROOT/runtime" \
  "$SMOKE_SANDBOX_ROOT/tmp"

export HOME="$SMOKE_SANDBOX_ROOT/home"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_RUNTIME_DIR="$SMOKE_SANDBOX_ROOT/runtime"
export TMPDIR="$SMOKE_SANDBOX_ROOT/tmp"
export NPM_CONFIG_CACHE="$XDG_CACHE_HOME/npm"
export NPM_CONFIG_PREFIX="$SMOKE_SANDBOX_ROOT/npm-prefix"
export NPM_CONFIG_USERCONFIG="$XDG_CONFIG_HOME/npm/npmrc"
export BUN_INSTALL="$SMOKE_SANDBOX_ROOT/bun-install"
export BUN_INSTALL_CACHE_DIR="$XDG_CACHE_HOME/bun-install"
export GIT_CONFIG_GLOBAL="$XDG_CONFIG_HOME/git/config"
export GIT_CONFIG_SYSTEM=/dev/null
unset APPDATA LOCALAPPDATA
export OPEN_ZK_KB_SMOKE_TEST=1
export OPEN_ZK_KB_SMOKE_SANDBOX_ROOT="$SMOKE_SANDBOX_ROOT"

# CI may restore the immutable model files outside the disposable smoke root.
# Copy only that explicitly provided model directory into the private cache;
# model execution continues to read and write exclusively inside the sandbox.
SMOKE_MODEL_CACHE_TARGET="$XDG_CACHE_HOME/open-zk-kb/models/Xenova/all-MiniLM-L6-v2"
SMOKE_MODEL_CACHE_SEEDED=false
if [ -n "${OPEN_ZK_KB_MODEL_CACHE_SEED:-}" ]; then
  case "$OPEN_ZK_KB_MODEL_CACHE_SEED" in
    */all-MiniLM-L6-v2) ;;
    *)
      echo "REFUSING MODEL CACHE SEED: expected all-MiniLM-L6-v2 directory" >&2
      exit 1
      ;;
  esac
  if [ ! -d "$OPEN_ZK_KB_MODEL_CACHE_SEED" ] || [ -L "$OPEN_ZK_KB_MODEL_CACHE_SEED" ]; then
    echo "REFUSING MODEL CACHE SEED: source is missing or symlinked" >&2
    exit 1
  fi
  if find "$OPEN_ZK_KB_MODEL_CACHE_SEED" -type l -print -quit | grep -q .; then
    echo "REFUSING MODEL CACHE SEED: source contains symlinks" >&2
    exit 1
  fi
  mkdir -p "$SMOKE_MODEL_CACHE_TARGET"
  cp -R "$OPEN_ZK_KB_MODEL_CACHE_SEED"/. "$SMOKE_MODEL_CACHE_TARGET"/
  SMOKE_MODEL_CACHE_SEEDED=true
fi

cd "$SMOKE_REPO_ROOT"

# Lightweight regression-test entry point. It proves inherited HOME/XDG values
# are ignored and that the deletion guard rejects the original user vault.
if [ "${1:-}" = "--verify-sandbox" ]; then
  if [ -n "$SMOKE_ORIGINAL_HOME" ] && smoke_rm_rf "$SMOKE_ORIGINAL_HOME/.local/share/open-zk-kb" 2>/dev/null; then
    echo "sandbox guard accepted the original vault" >&2
    exit 1
  fi
  printf 'SMOKE_SANDBOX_ROOT=%s\n' "$SMOKE_SANDBOX_ROOT"
  printf 'HOME=%s\n' "$HOME"
  printf 'XDG_CONFIG_HOME=%s\n' "$XDG_CONFIG_HOME"
  printf 'XDG_DATA_HOME=%s\n' "$XDG_DATA_HOME"
  printf 'XDG_STATE_HOME=%s\n' "$XDG_STATE_HOME"
  printf 'XDG_CACHE_HOME=%s\n' "$XDG_CACHE_HOME"
  printf 'XDG_RUNTIME_DIR=%s\n' "$XDG_RUNTIME_DIR"
  printf 'TMPDIR=%s\n' "$TMPDIR"
  printf 'NPM_CONFIG_CACHE=%s\n' "$NPM_CONFIG_CACHE"
  printf 'NPM_CONFIG_PREFIX=%s\n' "$NPM_CONFIG_PREFIX"
  printf 'NPM_CONFIG_USERCONFIG=%s\n' "$NPM_CONFIG_USERCONFIG"
  printf 'BUN_INSTALL=%s\n' "$BUN_INSTALL"
  printf 'BUN_INSTALL_CACHE_DIR=%s\n' "$BUN_INSTALL_CACHE_DIR"
  printf 'GIT_CONFIG_GLOBAL=%s\n' "$GIT_CONFIG_GLOBAL"
  printf 'MODEL_CACHE_DIR=%s\n' "$SMOKE_MODEL_CACHE_TARGET"
  printf 'MODEL_CACHE_SEEDED=%s\n' "$SMOKE_MODEL_CACHE_SEEDED"
  exit 0
fi

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

for FILE in dist/mcp-server.js dist/setup.js dist/cli.js; do
  if [ -f "$FILE" ]; then
    pass "$FILE exists"
  else
    fail "$FILE exists" "file not found"
  fi
done
echo ""

# ─── 2. Unit tests ───
echo "▸ Unit Tests"

if TEST_OUTPUT=$(bun test 2>&1); then
  PASS_COUNT=$(echo "$TEST_OUTPUT" | grep -oE "[0-9]+ pass" | head -1)
  pass "all unit tests pass ($PASS_COUNT)"
else
  FAIL_LINE=$(echo "$TEST_OUTPUT" | grep -oE "[0-9]+ fail" | head -1 || true)
  fail "unit tests" "${FAIL_LINE:-bun test exited non-zero without a matching summary line}"
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

for CLIENT in opencode claude-code cursor windsurf; do
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
)

declare -A CLIENT_NAMES
CLIENT_NAMES=(
  [opencode]="OpenCode"
  [claude-code]="Claude Code"
  [cursor]="Cursor"
  [windsurf]="Windsurf"
)

for CLIENT in opencode claude-code cursor windsurf; do
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
VAULT_PATH="$XDG_DATA_HOME/open-zk-kb"
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

for CLIENT in opencode claude-code cursor windsurf; do
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
if [ -f "$CONFIG_YAML" ]; then
  pass "config.yaml exists at ~/.config/open-zk-kb/"
  if grep -q "vault:" "$CONFIG_YAML" || grep -q "logLevel:" "$CONFIG_YAML"; then
    pass "config.yaml contains expected settings"
  else
    fail "config.yaml content" "missing expected settings (vault or logLevel)"
  fi
else
  fail "config.yaml copy" "not found at $CONFIG_YAML"
fi
echo ""

# ─── 8. MCP server protocol + KB round-trip ───
echo "▸ MCP Server Protocol + KB Round-Trip"

# Use a clean temporary vault to avoid state pollution from previous runs
MCP_VAULT_DIR=$(mktemp -d "$SMOKE_SANDBOX_ROOT/mcp-vault.XXXXXX")
MCP_OUTPUT=$(XDG_DATA_HOME="$MCP_VAULT_DIR" timeout 20 bun run tests/docker/mcp-protocol-test.ts 2>/dev/null || true)
smoke_rm_rf "$MCP_VAULT_DIR"
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

for CLIENT in opencode claude-code cursor windsurf; do
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

for CLIENT in opencode claude-code cursor windsurf; do
  CONFIG_PATH="${CLIENT_CONFIG_PATHS[$CLIENT]}"

  bun run src/setup.ts uninstall --client "$CLIENT" >/dev/null 2>&1 || true

  mkdir -p "$(dirname "$CONFIG_PATH")"
  if [ "$CLIENT" = "opencode" ]; then
    echo '{"mcp":{"other-server":{"type":"local","command":["node","other.js"],"enabled":true}}}' > "$CONFIG_PATH"
  else
    echo '{"mcpServers":{"other-server":{"command":"node","args":["other.js"]}}}' > "$CONFIG_PATH"
  fi

  bun run src/setup.ts install --client "$CLIENT" --force >/dev/null 2>&1 || true

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

JSON_CHECK_PATH="$TMPDIR/json-check.txt"
bun -e "
  const fs = require('fs');
  const readme = fs.readFileSync('README.md', 'utf-8');
  const blocks = [...readme.matchAll(/\`\`\`json\n([\s\S]*?)\n\`\`\`/g)].map(m => m[1]);
  let valid = 0;
  for (const block of blocks) {
    try { JSON.parse(block); valid++; } catch {}
  }
  console.log(blocks.length + ':' + valid);
" 2>/dev/null > "$JSON_CHECK_PATH" || echo "0:0" > "$JSON_CHECK_PATH"

BLOCK_COUNT=$(cut -d: -f1 "$JSON_CHECK_PATH")
BLOCK_VALID=$(cut -d: -f2 "$JSON_CHECK_PATH")

if [ "$BLOCK_COUNT" -eq 0 ]; then
  pass "README has no JSON blocks (none to validate)"
elif [ "$BLOCK_COUNT" -eq "$BLOCK_VALID" ]; then
  pass "all $BLOCK_COUNT README JSON blocks are valid"
else
  fail "README JSON" "$BLOCK_VALID/$BLOCK_COUNT blocks valid"
fi
echo ""

# ─── 16. MCP server works without pre-existing vault ───
echo "▸ MCP Server Fresh Start (no vault)"

smoke_rm_rf "$VAULT_PATH"

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

for CLIENT in opencode claude-code cursor windsurf; do
  bun run src/setup.ts uninstall --client "$CLIENT" >/dev/null 2>&1 || true
done

smoke_rm_rf "$VAULT_PATH"
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

NOTE_COUNT=$(find "$VAULT_PATH" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')
if [ "$NOTE_COUNT" -eq 2 ]; then
  pass "pre-existing vault has 2 notes"
else
  fail "pre-existing vault setup" "expected 2 notes, got $NOTE_COUNT"
fi

bun run src/setup.ts install --client cursor >/dev/null 2>&1 || true

POST_COUNT=$(find "$VAULT_PATH" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')
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

  const stats = await client.callTool({ name: 'knowledge-health', arguments: {} });
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

# Pack from a sandboxed staging copy. Never rewrite package.json or create
# tarballs in the developer's working tree.
PACK_SOURCE="$SMOKE_SANDBOX_ROOT/package-source"
PACK_OUTPUT_DIR="$SMOKE_SANDBOX_ROOT/package-output"
mkdir -p "$PACK_SOURCE" "$PACK_OUTPUT_DIR"
for SOURCE in package.json README.md LICENSE CHANGELOG.md server.json llms.txt dist patches skills skill-templates templates assets docs; do
  if [ -e "$SOURCE" ]; then
    cp -R "$SOURCE" "$PACK_SOURCE/"
  fi
done
node -e "const fs=require('fs'); const f=process.argv[1]; const p=JSON.parse(fs.readFileSync(f,'utf8')); delete p.patchedDependencies; fs.writeFileSync(f, JSON.stringify(p,null,2)+'\n');" "$PACK_SOURCE/package.json"
(
  cd "$PACK_SOURCE"
  bun pm pack --destination "$PACK_OUTPUT_DIR" || npm pack --pack-destination "$PACK_OUTPUT_DIR"
) >/dev/null 2>&1 || true
shopt -s nullglob
TARBALL=""
for CANDIDATE in "$PACK_OUTPUT_DIR"/open-zk-kb-*.tgz; do
  if [ -z "$TARBALL" ] || [ "$CANDIDATE" -nt "$TARBALL" ]; then
    TARBALL="$CANDIDATE"
  fi
done
shopt -u nullglob

if [ -n "$TARBALL" ] && [ -f "$TARBALL" ]; then
  pass "npm pack creates tarball"

  PACK_FILES=$(tar tzf "$TARBALL")

  for REQUIRED in package/dist/mcp-server.js package/dist/setup.js package/dist/cli.js package/package.json package/README.md; do
    if echo "$PACK_FILES" | grep -q "$REQUIRED"; then
      pass "tarball contains $REQUIRED"
    else
      fail "tarball contents" "missing $REQUIRED"
    fi
  done

  PACK_DIR=$(mktemp -d "$SMOKE_SANDBOX_ROOT/package-install.XXXXXX")
  mkdir -p "$PACK_DIR/test-install"
  TARBALL_NAME=$(basename "$TARBALL")
  cp "$TARBALL" "$PACK_DIR/test-install/$TARBALL_NAME"

  INSTALL_STATUS=0
  INSTALL_OUTPUT=$(
    cd "$PACK_DIR/test-install" &&
    echo '{"dependencies":{"open-zk-kb":"file:./'"$TARBALL_NAME"'"}}' > package.json &&
    bun install 2>&1
  ) || INSTALL_STATUS=$?

  if [ "$INSTALL_STATUS" -eq 0 ]; then
    BIN_SETUP="$PACK_DIR/test-install/node_modules/.bin/open-zk-kb"
    if [ -f "$BIN_SETUP" ] || [ -L "$BIN_SETUP" ]; then
      pass "open-zk-kb bin symlink created"
    else
      fail "bin symlink" "open-zk-kb not found in node_modules/.bin/"
    fi
  else
    fail "package install" "$(echo "$INSTALL_OUTPUT" | head -5)"
  fi

  smoke_rm_rf "$PACK_DIR"
  rm -f "$TARBALL"
else
  fail "npm pack" "no tarball created"
fi
echo ""

# ─── 20. CLI entry points respond ───
echo "▸ CLI Entry Points"

OUTPUT=$(timeout 5 bun dist/cli.js --help 2>&1 || true)
if echo "$OUTPUT" | grep -qi "install\|uninstall\|usage"; then
  pass "open-zk-kb --help works"
else
  fail "open-zk-kb --help" "no help output: $(echo "$OUTPUT" | head -1)"
fi

OUTPUT=$(timeout 5 bun dist/cli.js install --client cursor --dry-run 2>&1 || true)
if echo "$OUTPUT" | grep -q "Dry run"; then
  pass "open-zk-kb install via dist/cli.js"
else
  fail "CLI install" "$(echo "$OUTPUT" | head -1)"
fi
echo ""

# ─── 21. Local model smoke tests (if LOCAL_MODELS=1) ───
if [ "${LOCAL_MODELS:-}" = "1" ]; then
  echo "▸ Local Model Quality Tests"

  MODEL_OUTPUT=$(timeout 300 bun run tests/docker/model-smoke-test.ts 2>/dev/null || true)
  echo "$MODEL_OUTPUT" | grep -E "^  [✅❌⏱]" || true

  MODEL_RESULT=$(echo "$MODEL_OUTPUT" | grep "MODEL_SMOKE_RESULT" || echo "MODEL_SMOKE_RESULT:0:12")
  MODEL_PASS=$(echo "$MODEL_RESULT" | cut -d: -f2)
  MODEL_FAIL=$(echo "$MODEL_RESULT" | cut -d: -f3)
  PASS=$((PASS + MODEL_PASS))
  FAIL=$((FAIL + MODEL_FAIL))
  if [ "$MODEL_FAIL" -gt 0 ]; then
    TESTS+=("FAIL: Local model tests — $MODEL_FAIL failures")
  fi
  echo ""
else
  echo "▸ Local Model Tests (skipped — set LOCAL_MODELS=1 to enable)"
  echo ""
fi

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
