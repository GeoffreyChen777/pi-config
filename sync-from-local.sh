#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

mkdir -p "$ROOT/agent"

cp "$SRC/settings.json" "$ROOT/agent/settings.json"
cp "$SRC/models.json" "$ROOT/agent/models.json"
cp "$SRC/mcp.json" "$ROOT/agent/mcp.json"
cp "$SRC/compact-ui.json" "$ROOT/agent/compact-ui.json"
cp "$SRC/permission-control.json" "$ROOT/agent/permission-control.json"
if [[ -d "$SRC/extension-settings" ]]; then
  mkdir -p "$ROOT/agent/extension-settings"
  cp "$SRC/extension-settings"/*.json "$ROOT/agent/extension-settings/" 2>/dev/null || true
fi
if [[ -f "$SRC/npm/package.json" ]]; then
  node - "$SRC/npm" "$ROOT/agent/npm-package.json" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const npmRoot = process.argv[2];
const output = process.argv[3];
const source = JSON.parse(fs.readFileSync(path.join(npmRoot, "package.json"), "utf8"));
const dependencies = {};

for (const name of Object.keys(source.dependencies ?? {})) {
  const manifest = path.join(npmRoot, "node_modules", name, "package.json");
  if (!fs.existsSync(manifest)) {
    throw new Error(`Installed package manifest not found: ${manifest}`);
  }
  dependencies[name] = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
}

fs.writeFileSync(
  output,
  JSON.stringify(
    {
      name: source.name ?? "pi-extensions",
      private: true,
      dependencies,
    },
    null,
    2,
  ) + "\n",
);
NODE
fi

# Local extension source is intentionally not synced. The active extensions are
# published npm packages declared in settings.json and npm-package.json.
rm -rf "$ROOT/agent/extensions"
rm -f "$ROOT/agent/compact-mode.json"

echo "Synced from $SRC into $ROOT"
echo "Review git status before committing. Do not add auth.json, sessions, or caches."
