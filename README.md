# pi-config

Personal Pi coding-agent config from this machine (`~/.pi/agent`).

Private on purpose: it encodes model routing, MCP, and local extensions. It does **not** contain API keys, OAuth tokens, or session transcripts.

## What's in here

```text
agent/
  settings.json              # theme, default model, packages, UI
  models.json                # custom providers (MVP Lab / DeepSeek / OpenCode)
  mcp.json                   # mvp-lab-discord MCP
  compact-mode.json          # compact-mode extension prefs
  permission-control.json    # sandbox / approval policy
  npm-package.json           # installed pi packages (versions)
  auth.json.example          # credential slots only
  extensions/
    compact-mode/            # local UI extension
    editor-info/             # local editor chrome
    permission-control/      # local permission extension (currently disabled in settings)
    subagents/               # planner / actor / reviewer
    pi-better-compaction/    # package override config
```

Intentionally **not** synced:

- `auth.json` (API keys)
- `sessions/` (chat history)
- `npm/node_modules` (reinstall with `pi install`)
- `mcp-cache.json`, `models-store.json`
- `permission-control-audit.jsonl`
- OAuth tokens in the OS keychain
- `~/.agents/skills/mvp-agent-kit` (its own repo)

## Restore on a new machine

```bash
git clone git@github.com:GeoffreyChen777/pi-config.git ~/Developer/pi-config
cd ~/Developer/pi-config
./install.sh
```

Then:

1. Copy `agent/auth.json.example` → `~/.pi/agent/auth.json` and fill keys, **or** run `pi` and `/login`.
2. Export `MVP_LAB_MODEL_API_KEY` (used by `models.json`).
3. Restart pi so packages in `settings.json` install.
4. Clone skills separately:

```bash
mkdir -p ~/.agents/skills
git clone git@github.com:mvp-ai-lab/mvp-agent-kit.git ~/.agents/skills/mvp-agent-kit
```

5. For Discord MCP: `/mcp-auth mvp-lab-discord` (browser SSO). Callback is `http://localhost:8976/callback`.

## Update this repo from the current machine

```bash
cd ~/Developer/pi-config
./sync-from-local.sh
git add -A
git status   # confirm no secrets
git commit -m "sync pi config"
git push
```
