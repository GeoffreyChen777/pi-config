#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

mkdir -p "$DEST"

copy_file() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
}

copy_file "$ROOT/agent/settings.json" "$DEST/settings.json"
copy_file "$ROOT/agent/models.json" "$DEST/models.json"
copy_file "$ROOT/agent/mcp.json" "$DEST/mcp.json"
copy_file "$ROOT/agent/compact-ui.json" "$DEST/compact-ui.json"
copy_file "$ROOT/agent/permission-control.json" "$DEST/permission-control.json"

# This setup is npm-only. Remove stale local extension and agent definitions
# from older versions of the configuration.
rm -rf "$DEST/extensions" "$DEST/extensions.disabled" "$DEST/agents"
rm -f "$DEST/compact-mode.json"
mkdir -p "$DEST/extensions" "$DEST/extensions.disabled"

if [[ ! -f "$DEST/auth.json" ]]; then
  copy_file "$ROOT/agent/auth.json.example" "$DEST/auth.json"
  echo "Wrote placeholder $DEST/auth.json — fill keys or run pi /login"
else
  echo "Keeping existing $DEST/auth.json"
fi

if [[ -f "$ROOT/agent/npm-package.json" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to restore Pi packages" >&2
    exit 1
  fi

  mkdir -p "$DEST/npm"
  copy_file "$ROOT/agent/npm-package.json" "$DEST/npm/package.json"
  NPM_CACHE="${PI_CONFIG_NPM_CACHE:-/tmp/pi-config-npm-cache-${UID:-user}}"
  npm install \
    --cache "$NPM_CACHE" \
    --prefix "$DEST/npm" \
    --legacy-peer-deps
fi

echo "Installed pi config into $DEST"
echo "Restart pi to load the restored npm packages."
echo "Skills are not in this repo: clone mvp-ai-lab/mvp-agent-kit into ~/.agents/skills/"
