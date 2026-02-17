#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "Building packages..."
bun run build

echo "Building API binary..."
bun run build:api

echo "Building CLI binary..."
bun run build:cli

INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "$INSTALL_DIR"

echo "Installing to $INSTALL_DIR..."
cp packages/api/dist/ossgard-api "$INSTALL_DIR/ossgard-api"
cp packages/cli/dist/ossgard "$INSTALL_DIR/ossgard"

echo "Done. Installed to $INSTALL_DIR"

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  echo "WARNING: $INSTALL_DIR is not in your PATH."
  echo "Add this to your shell profile:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
