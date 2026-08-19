#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

mkdir -p "$DEST/extensions"

copy_file() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
}

copy_file "$ROOT/agent/settings.json" "$DEST/settings.json"
copy_file "$ROOT/agent/models.json" "$DEST/models.json"
copy_file "$ROOT/agent/mcp.json" "$DEST/mcp.json"
copy_file "$ROOT/agent/compact-mode.json" "$DEST/compact-mode.json"
copy_file "$ROOT/agent/permission-control.json" "$DEST/permission-control.json"

rsync -a --delete --exclude node_modules --exclude .git \
  "$ROOT/agent/extensions/" "$DEST/extensions/"

if [[ ! -f "$DEST/auth.json" ]]; then
  copy_file "$ROOT/agent/auth.json.example" "$DEST/auth.json"
  echo "Wrote placeholder $DEST/auth.json — fill keys or run pi /login"
else
  echo "Keeping existing $DEST/auth.json"
fi

if [[ -f "$DEST/extensions/permission-control/package.json" ]]; then
  (cd "$DEST/extensions/permission-control" && npm install --omit=dev)
fi

echo "Installed pi config into $DEST"
echo "Restart pi. Packages listed in settings.json will install on startup."
echo "Skills are not in this repo: clone mvp-ai-lab/mvp-agent-kit into ~/.agents/skills/"
