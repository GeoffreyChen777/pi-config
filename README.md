# pi-config

Public, reproducible configuration for my
[Pi Coding Agent](https://github.com/earendil-works/pi-mono) environment.

The repository tracks UI preferences, model routing, MCP server definitions,
permission policy, and the exact npm package set. Local extension source has
been replaced by published Pi packages.

> [!IMPORTANT]
> This repository intentionally contains no API keys, OAuth tokens, session
> transcripts, audit logs, or local caches.

## Contents

```text
agent/
├── settings.json             # model, package, UI, and TUI settings
├── models.json               # custom provider and model definitions
├── mcp.json                  # MVP Lab Discord and Wiki MCP servers
├── compact-ui.json           # pi-compact-ui display preferences
├── permission-control.json   # permission profiles, sandbox, and judge policy
├── npm-package.json          # installed package versions
└── auth.json.example         # environment-variable credential placeholders
```

There are no local extensions under `agent/extensions/`. Every active extension
is installed from npm.

## Installed Pi Packages

| Package | Version |
|---|---:|
| `pi-web-search` | `1.3.1` |
| `@lll9p/pi-better-compaction` | `0.4.0` |
| `pi-codex-tools` | `0.2.3` |
| `@narumitw/pi-goal` | `0.53.1` |
| `@tunnckocore/pi-gpt-fast-mode` | `0.4.0` |
| `pi-mcp-adapter` | `2.27.0` |
| `pi-compact-ui` | `0.1.0` |
| `pi-editor-info` | `0.1.0` |
| `pi-permission-control` | `0.2.0` |
| `pi-agent-squad` | `0.7.0` |

## Not Synced

- `agent/auth.json` — API keys and provider credentials
- `agent/sessions/` — conversation history
- `agent/npm/node_modules/` — restored from `npm-package.json`
- `agent/mcp-cache.json` and `agent/models-store.json`
- `agent/permission-control-audit.jsonl`
- OAuth credentials stored in the operating-system keychain
- `~/.agents/skills/mvp-agent-kit` — maintained in its own repository

## Restore on a New Machine

```bash
git clone git@github.com:GeoffreyChen777/pi-config.git ~/Developer/pi-config
cd ~/Developer/pi-config
./install.sh
```

The installer:

1. Copies the public configuration into `${PI_CODING_AGENT_DIR:-~/.pi/agent}`.
2. Removes stale local extensions.
3. Installs the package versions declared in `agent/npm-package.json`.
4. Preserves an existing `auth.json`.

After installation:

1. If needed, copy `agent/auth.json.example` to `~/.pi/agent/auth.json`, or use
   Pi's `/login` command.
2. Export `MVP_LAB_MODEL_API_KEY` for the MVP Lab providers in `models.json`.
3. Start or restart Pi.
4. Authenticate the MCP servers:

   ```text
   /mcp-auth mvp-lab-discord
   /mcp-auth mvp-lab-wiki
   ```

5. Restore the separately maintained skills:

   ```bash
   mkdir -p ~/.agents/skills
   git clone git@github.com:mvp-ai-lab/mvp-agent-kit.git \
     ~/.agents/skills/mvp-agent-kit
   ```

## Sync from the Current Machine

```bash
cd ~/Developer/pi-config
./sync-from-local.sh
git diff --check
git status
```

Review the diff for secrets before committing:

```bash
git add -A
git commit -m "sync current Pi configuration"
git push
```
