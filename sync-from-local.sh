#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

mkdir -p "$ROOT/agent/extensions"

cp "$SRC/settings.json" "$ROOT/agent/settings.json"
cp "$SRC/models.json" "$ROOT/agent/models.json"
cp "$SRC/mcp.json" "$ROOT/agent/mcp.json"
cp "$SRC/compact-mode.json" "$ROOT/agent/compact-mode.json"
cp "$SRC/permission-control.json" "$ROOT/agent/permission-control.json"
if [[ -f "$SRC/npm/package.json" ]]; then
  cp "$SRC/npm/package.json" "$ROOT/agent/npm-package.json"
fi

rsync -a --delete --exclude node_modules --exclude .git \
  "$SRC/extensions/" "$ROOT/agent/extensions/"

echo "Synced from $SRC into $ROOT"
echo "Review git status before committing. Do not add auth.json, sessions, or caches."
