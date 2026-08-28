# pi-config

Public, reproducible configuration for my
[Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) environment.

The repository tracks UI preferences, model routing, MCP server definitions,
permission policy, and the exact npm package set. Local extension source has
been replaced by published Pi packages.

> [!IMPORTANT]
> This repository intentionally contains **no API keys, OAuth tokens, session
> transcripts, audit logs, or local caches.** Credentials are supplied at
> install time (env var or interactive prompt).

## One-command restore

```bash
git clone https://github.com/GeoffreyChen777/pi-config.git
cd pi-config
./install.sh
```

Requirements the installer will check (install them first if missing):

| Tool | Why |
|---|---|
| `git` | restores the skills repo |
| `node` ≥ 20 + `npm` | installs the exact pi package set |

Optional: `MVP_LAB_MODEL_API_KEY` — if set, `install.sh` writes
`~/.pi/agent/auth.json` non-interactively. Without it, the installer prompts
for the key (or you can run `pi /login mvp-lab` afterwards).

What `install.sh` does:

1. Backs up any existing config to `~/.pi/agent/backups/<timestamp>/`.
2. Copies `settings.json`, `models.json`, `mcp.json`, `compact-ui.json`,
   `permission-control.json`, and `extension-settings/provider-newapi.json`.
3. Removes stale local extensions and legacy caches (`models-store.json`).
4. Installs the exact package versions from `agent/npm-package.json`
   (`npm install --legacy-peer-deps`), then verifies every package referenced
   in `settings.json` is declared.
5. Writes `auth.json` (env var → interactive → skip) — never from the repo.
6. Clones/updates the skills repo (`mvp-agent-kit`) into `~/.agents/skills/`.
7. Prints next steps (restart pi, `/model`, `/mcp-auth`).

Idempotent: re-running restores to the repo state while preserving `auth.json`
and backing up previous config.

## Contents

```text
agent/
├── settings.json             # model, package, UI, and TUI settings
├── models.json               # custom provider and model definitions
├── mcp.json                  # MVP Lab Discord and Wiki MCP servers
├── compact-ui.json           # pi-compact-ui display preferences
├── permission-control.json   # permission profiles, sandbox, and judge policy
├── npm-package.json          # exact installed package versions
├── auth.json.example         # credential template (no real keys)
└── extension-settings/
    └── provider-newapi.json  # NewAPI gateway definition (URL only)
```

There are no local extensions under `agent/extensions/`. Every active extension
is installed from npm.

## Model setup

`models.json` is intentionally empty — all models come from the `mvp-lab`
NewAPI gateway via the `pi-provider-newapi` extension (dynamic discovery of
`GET /v1/models`). `extension-settings/provider-newapi.json` points the
extension at the gateway; the API key lives in `auth.json`.

## Installed Pi Packages

| Package | Version |
|---|---:|
| `pi-web-search` | `1.3.1` |
| `@lll9p/pi-better-compaction` | `0.6.0` |
| `pi-codex-tools` | `0.2.3` |
| `@narumitw/pi-goal` | `0.54.3` |
| `@tunnckocore/pi-gpt-fast-mode` | `0.4.0` |
| `pi-mcp-adapter` | `2.29.0` |
| `pi-compact-ui` | `0.1.0` |
| `pi-editor-info` | `0.1.0` |
| `pi-permission-control` | `0.2.0` |
| `pi-agent-squad` | `0.8.0` |
| `pi-provider-newapi` | `0.5.0` |

## Not Synced

- `agent/auth.json` — API keys and provider credentials
- `agent/sessions/` — conversation history
- `agent/npm/node_modules/` — restored from `npm-package.json`
- `agent/mcp-cache.json` and `agent/models-store.json`
- `agent/permission-control-audit.jsonl`
- OAuth credentials stored in the operating-system keychain
- `~/.agents/skills/mvp-agent-kit` — maintained in its own repository

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
