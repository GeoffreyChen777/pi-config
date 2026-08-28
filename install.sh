#!/usr/bin/env bash
#
# pi-config installer — restore a full Pi Coding Agent environment
# from this repository with a single command.
#
#   ./install.sh
#   PI_CODING_AGENT_DIR=/custom/path ./install.sh
#
# This script installs the public configuration, npm packages, skills, and
# (when possible) credentials. It never commits secrets: API keys come from
# the environment or are entered interactively at install time.
#
# Requirements (checked at startup):
#   - git  (needed to restore skills)
#   - node >= 20, npm   (needed to install the npm package set)
#   - a working network connection
# Optional:
#   - MVP_LAB_MODEL_API_KEY  env var: writes ~/.pi/agent/auth.json with the
#     mvp-lab credential without prompting.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SKILLS_DIR="${PI_AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
SKILL_REPO="https://github.com/mvp-ai-lab/mvp-agent-kit.git"
NOW="$(date +%Y%m%d-%H%M%S)"

info()  { printf '\033[1;34m==> %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m    %s\033[0m\n' "$*"; }
warn()  { printf '\033[1;33m!!  %s\033[0m\n' "$*" >&2; }
die()   { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. Prerequisites
# ---------------------------------------------------------------------------
command -v git  >/dev/null 2>&1 || die "git is required (restores skills). Install git and re-run."
command -v node >/dev/null 2>&1 || die "node is required (installs pi packages). Install Node.js >= 20 and re-run."
command -v npm  >/dev/null 2>&1 || die "npm is required (installs pi packages). Install npm and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  die "node $(node -p 'process.versions.node') is too old — need >= 20. Install a newer Node.js and re-run."
fi

info "Installing pi-config into: $AGENT_DIR"
mkdir -p "$AGENT_DIR" "$AGENT_DIR/extension-settings"

# ---------------------------------------------------------------------------
# 1. Backup any existing configuration (idempotent + safe)
# ---------------------------------------------------------------------------
BACKUP_DIR="$AGENT_DIR/backups/$NOW"
if [[ -d "$AGENT_DIR/backups" ]]; then
  mkdir -p "$BACKUP_DIR"
  for f in settings.json models.json mcp.json compact-ui.json permission-control.json; do
    [[ -f "$AGENT_DIR/$f" ]] && cp "$AGENT_DIR/$f" "$BACKUP_DIR/"
  done
  [[ -d "$AGENT_DIR/extension-settings" ]] && \
    cp -r "$AGENT_DIR/extension-settings" "$BACKUP_DIR/" 2>/dev/null || true
  ok "Backed up previous config to $BACKUP_DIR"
fi

# ---------------------------------------------------------------------------
# 2. Public configuration files
# ---------------------------------------------------------------------------
copy_file() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
}

copy_file "$ROOT/agent/settings.json"             "$AGENT_DIR/settings.json"
copy_file "$ROOT/agent/models.json"               "$AGENT_DIR/models.json"
copy_file "$ROOT/agent/mcp.json"                  "$AGENT_DIR/mcp.json"
copy_file "$ROOT/agent/compact-ui.json"           "$AGENT_DIR/compact-ui.json"
copy_file "$ROOT/agent/permission-control.json"   "$AGENT_DIR/permission-control.json"
copy_file "$ROOT/agent/extension-settings/provider-newapi.json" \
                                                  "$AGENT_DIR/extension-settings/provider-newapi.json"
ok "Copied settings, models, mcp, compact-ui, permission-control, extension-settings"

# ---------------------------------------------------------------------------
# 3. Remove stale local extensions / legacy resources
# ---------------------------------------------------------------------------
rm -rf "$AGENT_DIR/extensions" "$AGENT_DIR/extensions.disabled" "$AGENT_DIR/agents"
rm -f  "$AGENT_DIR/compact-mode.json"
# Stale dynamic-provider caches from previous static provider configs
rm -f  "$AGENT_DIR/models-store.json"
mkdir -p "$AGENT_DIR/extensions" "$AGENT_DIR/extensions.disabled"
ok "Cleaned stale extensions, agents, and caches"

# ---------------------------------------------------------------------------
# 4. npm packages (exact versions from npm-package.json)
# ---------------------------------------------------------------------------
info "Installing pi npm packages (this can take a while)..."
mkdir -p "$AGENT_DIR/npm"
copy_file "$ROOT/agent/npm-package.json" "$AGENT_DIR/npm/package.json"
NPM_CACHE="${PI_CONFIG_NPM_CACHE:-/tmp/pi-config-npm-cache-${UID:-user}}"
npm install \
  --cache "$NPM_CACHE" \
  --prefix "$AGENT_DIR/npm" \
  --legacy-peer-deps \
  --no-audit --no-fund
ok "Installed npm packages (see $AGENT_DIR/npm/package.json)"

# Verify every package referenced in settings.json is actually installed.
node - "$AGENT_DIR" "$ROOT/agent" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [agentDir, repoAgentDir] = process.argv.slice(2);

const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(repoAgentDir, "npm-package.json"), "utf8"));
const missing = [];
const seen = [];
for (const p of settings.packages ?? []) {
  const name =
    typeof p === "string"
      ? p.replace(/^npm:/, "")
      : p && typeof p.source === "string"
        ? p.source.replace(/^npm:/, "")
        : null;
  if (!name) {
    missing.push(typeof p === "string" ? p : JSON.stringify(p));
    continue;
  }
  seen.push(name);
  if (!manifest.dependencies[name]) missing.push("npm:" + name);
}
if (missing.length) {
  console.error("settings.json references packages not in npm-package.json: " + missing.join(", "));
  process.exit(1);
}
console.log("Verified: all " + (settings.packages ?? []).length + " packages in settings.json are declared.");
NODE

# ---------------------------------------------------------------------------
# 5. Credentials (auth.json) — never from the repo
# ---------------------------------------------------------------------------
AUTH_EXISTS=0
if [[ -f "$AGENT_DIR/auth.json" ]]; then
  AUTH_EXISTS=1
  ok "Keeping existing $AGENT_DIR/auth.json"
fi

if [[ "$AUTH_EXISTS" == "0" ]]; then
  if [[ -n "${MVP_LAB_MODEL_API_KEY:-}" ]]; then
    node - "$AGENT_DIR" "$MVP_LAB_MODEL_API_KEY" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [agentDir, key] = process.argv.slice(2);
const auth = { "mvp-lab": { type: "api_key", key } };
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
console.log("Wrote auth.json from MVP_LAB_MODEL_API_KEY");
NODE
  elif [[ -t 0 ]]; then
    warn "No auth.json found and MVP_LAB_MODEL_API_KEY is not set."
    warn "Enter the MVP Lab model API key (paste, then Enter):"
    read -r -s -p "  mvp-lab key: " MVP_KEY || true
    printf '\n'
    if [[ -n "${MVP_KEY:-}" ]]; then
      node - "$AGENT_DIR" "$MVP_KEY" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [agentDir, key] = process.argv.slice(2);
const auth = { "mvp-lab": { type: "api_key", key } };
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
console.log("Wrote auth.json");
NODE
    else
      warn "No key entered — you can run 'pi /login mvp-lab' later."
    fi
  else
    warn "No auth.json and no key available (non-interactive)."
    warn "Set MVP_LAB_MODEL_API_KEY and re-run, or use 'pi /login mvp-lab' after installing."
  fi
fi

# ---------------------------------------------------------------------------
# 6. Skills (separately maintained repo)
# ---------------------------------------------------------------------------
info "Restoring skills into $SKILLS_DIR"
mkdir -p "$SKILLS_DIR"
if [[ -d "$SKILLS_DIR/mvp-agent-kit/.git" ]]; then
  ( cd "$SKILLS_DIR/mvp-agent-kit" && git pull --ff-only --quiet ) || warn "Could not update existing skills (will keep current)."
  ok "Updated existing skills at $SKILLS_DIR/mvp-agent-kit"
else
  if [[ -e "$SKILLS_DIR/mvp-agent-kit" ]]; then
    warn "$SKILLS_DIR/mvp-agent-kit exists but is not a git checkout — leaving it alone."
  else
    git clone --quiet "$SKILL_REPO" "$SKILLS_DIR/mvp-agent-kit"
    ok "Cloned skills into $SKILLS_DIR/mvp-agent-kit"
  fi
fi

# ---------------------------------------------------------------------------
# 7. Summary
# ---------------------------------------------------------------------------
printf '\n'
info "Install complete."
printf '\n'
printf '  Config:  %s\n' "$AGENT_DIR"
printf '  Packages: %s (from %s)\n' "$(node -p "Object.keys(require('$ROOT/agent/npm-package.json').dependencies).length")" "agent/npm-package.json"
printf '  Skills:  %s\n' "$SKILLS_DIR/mvp-agent-kit"
if [[ -f "$AGENT_DIR/auth.json" ]]; then
  printf '  Auth:    %s (present)\n' "$AGENT_DIR/auth.json"
else
  printf '  Auth:    NOT configured — run "pi /login mvp-lab" or set MVP_LAB_MODEL_API_KEY\n'
fi
printf '\n'
printf '  Next steps:\n'
printf '    1. Restart pi (or run /reload inside it)\n'
printf '    2. /model  → pick mvp-lab/<model>\n'
printf '    3. /mcp-auth mvp-lab-discord   (OAuth)\n'
printf '    4. /mcp-auth mvp-lab-wiki      (OAuth)\n'
printf '    5. Optionally: pi install npm:pi-provider-newapi is already included via settings.json\n'
printf '\n'
