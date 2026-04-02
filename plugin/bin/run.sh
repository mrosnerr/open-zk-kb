#!/bin/bash
# Platform detection and binary selection for open-zk-kb MCP server

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Detect OS
case "$(uname -s)" in
  Darwin*) OS="darwin" ;;
  Linux*)  OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
  *)       echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

# Detect architecture
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)            echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

BINARY="$SCRIPT_DIR/open-zk-kb-${OS}-${ARCH}"

# Add .exe extension on Windows
if [ "$OS" = "windows" ]; then
  BINARY="${BINARY}.exe"
fi

if [ ! -x "$BINARY" ]; then
  echo "Binary not found or not executable: $BINARY" >&2
  echo "Available binaries:" >&2
  ls -la "$SCRIPT_DIR"/open-zk-kb-* 2>/dev/null >&2
  exit 1
fi

exec "$BINARY" "$@"
