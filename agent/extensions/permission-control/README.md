# permission-control

Codex-style permission control for [Pi](https://pi.dev), implemented as a local
extension. It enforces a **workspace-write** sandbox mode with an
**on-request** approval policy by default, and reuses
[`@landstrip/landstrip`](https://www.npmjs.com/package/@landstrip/landstrip) as
the OS-sandbox backend for bash (it is never reimplemented).

```
~/.pi/agent/extensions/permission-control/
├── package.json      # deps (typebox, @landstrip/landstrip optional)
├── index.ts          # entry: gates tools, prompt UI + ask resolution, commands
├── policy.ts         # unified decision engine: deny > ask > allow
├── paths.ts          # path normalization, symlink resolution, classification
├── bash.ts           # conservative structured bash parser/analyzer
├── approvals.ts      # grants (once/session/project/global) + FIFO coordinator
├── judge.ts          # approve-for-me model judge (ctx.modelRegistry.complete)
├── channel.ts        # subagent approval forwarding (reuses the message channel)
├── sandbox.ts        # @landstrip/landstrip policy generation + preflight + bash wrap
├── audit.ts          # transparent audit log + chat redaction
├── config.ts         # config model, defaults, atomic load/save
├── tsconfig.check.json  # typecheck config (npm install && tsc -p tsconfig.check.json)
└── README.md
```

## Installation

Copy (or symlink) this directory to `~/.pi/agent/extensions/permission-control/`
and restart Pi. The runtime dependency set is tiny:

```bash
cd ~/.pi/agent/extensions/permission-control
npm install --omit=dev     # pulls @landstrip/landstrip + native binary + typebox
```

For type checking (optional):

```bash
npm install                # also installs the pi type packages as devDeps
npx tsc -p tsconfig.check.json
```

The extension loads fine without `@landstrip/landstrip`; the permission layer
still gates everything. The OS sandbox adds kernel-level enforcement for bash
when the binary is present (macOS Seatbelt / Linux Landlock+seccomp / Windows
AppContainer). Verify with `/perm-sandbox`.

## Trust model (read this)

- The **main Pi process and this host extension are the trusted control
  plane.** The model cannot modify the extension, its policy file, or the
  approval prompt. This is policy enforcement, not a full isolation boundary.
- The permission layer decides **allow / ask / deny** for every normalized
  operation with strict precedence **deny > ask > allow**.
- When `@landstrip/landstrip` is available and `sandbox.enabled` is true, an
  allowed bash command is additionally executed inside the OS sandbox
  (`landstrip run -p <policy> -- bash -c '…'`) using the same policy. File
  tools run a **Sandbox Policy preflight** so file access always agrees with
  what the OS sandbox would allow.
- On Unix-like systems the generated policy grants exact read/write access to
  `/dev/null`. Git and many shell utilities use this non-persistent sink during
  normal startup; allowing the exact device avoids seccomp open failures
  without exposing the rest of `/dev`.
- Hard-denied paths (`~/.ssh`, private keys, `.env`, Pi permission/trust
  config) can **never** be approved around. `full-access` mode disables the
  gate entirely (the user explicitly opts out of all checks).

## Default behavior (`workspace-write` + `on-request`)

| Operation | Decision |
|---|---|
| read / write / edit / grep / find / ls inside the workspace | **allow** |
| bash that reads/writes inside the workspace (safe commands) | **allow** |
| read / write outside the workspace | **ask** |
| network commands (`curl`, `npm install`, `git push`, `ssh`, …) | **ask** |
| dangerous commands (`sudo`, `rm -rf`, `dd`, `chmod 777`, `mkfs`, …) | **ask** |
| sensitive paths (`.env`, `*.pem`, `*.key`, `id_rsa`, …) | **ask** (soft) |
| `~/.ssh`, Pi permission/trust config, configured hard-deny | **deny** (hard) |
| unparseable bash (fail-closed) | **ask** → deny when headless |

## Modes & policies

- **sandbox mode**: `workspace-write` (default) · `read-only` · `full-access`
- **approval policy**: `on-request` (default) · `untrusted` · `never` ·
  `approve-for-me`
  - `on-request` — ask the user for every `ask`.
  - `untrusted` / `never` — deny anything not explicitly allowed; no prompts.
  - `approve-for-me` — a configurable model (defaults to the active model via
    `ctx.modelRegistry.complete`, so no extra API keys) acts as a Codex
    Guardian-style reviewer. It evaluates visible user authorization, exact
    target/scope, payload+destination for egress, credential probing,
    persistent security weakening, and destructive/reversibility risk.
    Reviewer denials are final for that exact action; reviewer failures can
    fall back to the user in interactive sessions and fail closed headless.

Configure interactively with `/perm-config`, or edit
`~/.pi/agent/permission-control.json` (global) / `.pi/permission-control.json`
(project). Example:

```json
{
  "sandboxMode": "workspace-write",
  "approvalPolicy": "on-request",
  "approveForMe": { "timeoutMs": 30000 },
  "sandbox": { "enabled": true, "requireLandstrip": false },
  "hardDeny": { "paths": ["~/.ssh", "~/.aws/credentials"] },
  "audit": { "enabled": true }
}
```

`approveForMe.autoApproveRisk` is retained only for compatibility with older
configuration files. Guardian policy now makes the approval decision directly;
there is no user-selected risk allowlist. Low/medium actions may be approved,
high-risk actions require explicit user authorization for the exact scope, and
critical-risk actions are denied.

When Guardian determines that a non-critical action lacks explicit user
authorization, the tool result instructs the main agent to stop, explain the
exact action/target/scope to the user, and ask the user to explicitly reply
that they allow it. The agent must not retry or work around the boundary before
a new user message supplies that authorization. Critical and non-overridable
policy denials remain final.

Guardian denials use the Codex-style rejection circuit breaker: the current
turn terminates after 3 consecutive denials or 10 denials among the most recent
50 reviews. The main agent is instructed not to retry a denied outcome through
an indirect workaround.

## Approval prompts (Codex style)

When an `ask` is raised, the TUI shows the capability, resource, command,
justification and risk, with:

- **Allow once** — one-shot grant, consumed after the tool runs.
- **Allow for session** — matches the exact path/command for the session.
- **Allow path/prefix** (or **Allow command prefix** / **Allow this domain**)
  — broader session grant.
- **Allow for project** — persisted atomically to `.pi/permission-control.json`.
- **Deny** — blocks this call (agent can retry differently).
- **Abort** — blocks and terminates the turn.

Prompts are serialized through a FIFO coordinator so parallel tool calls never
interleave dialogs; requests are abortable and pending prompts are cancelled
on session shutdown.

### Proactive approval (`request_approval` tool)

The agent can ask before acting by calling `request_approval` with a
`justification`, required `capability`, `resource` scope, and optional
`command` prefix. The system prompt tells the model to do this for high-risk
operations. If approved, the returned scope tells it to proceed; if denied it
must stop rather than work around the denial.

## Subagents

Headless subagents (e.g. the `subagents` extension's planner/actor/reviewer)
have no TUI. When a subagent hits an `ask`, permission-control **forwards the
request to the main session over the existing master↔subagent message channel**
(`/tmp/pi-subagents-messages/<sessionId>`, `permission-control/` namespace) and
waits for the user's decision. This supports:

- user allow/deny in the main TUI,
- per-request **timeout** (`subagentApprovalTimeoutMs`, default 120s) and
  **abort** (Esc cancels the subagent turn),
- **concurrent cleanup** — requests are serialized, and stale request/reply
  files are removed on session shutdown.

If no channel exists, the subagent fails closed (deny).

## Bash analysis

Bash is parsed conservatively: pipes, `&&`/`||`/`;`, redirects, backgrounding,
`sudo`/`su`, `env`, `xargs`, `nohup`/`nice`/`timeout`, `bash -c`/`sh -c`,
`$(…)`/backticks and subshells are decomposed recursively. Path operands are
normalized, `~`-expanded, and **symlink-resolved** before classification.
Unparseable input is treated as `ask` (fail-closed when headless).

## Audit

Every decision is appended to `~/.pi/agent/permission-control-audit.jsonl`
(JSONL: agent, tool, capability, resource, verdict, risk, grant scope, reason).
Secrets, API tokens, request ids and routing details are **redacted from
anything shown in the chat transcript** (`/perm-log` shows a safe summary; the
file keeps non-secret detail). Disable with `audit.enabled: false`.

## Commands

- `/perm` — status (mode, policy, grants, sandbox backend)
- `/perm-config` — change mode/policy interactively (global or project)
- `/perm-allow path|command|capability|domain <value> [project|global]`
- `/perm-approve` — add explicit user authorization for one exact retry; the
  retry still passes through Guardian and does not bypass the sandbox
- `/perm-log` — recent audit decisions
- `/perm-sandbox` — OS sandbox backend status

## Compatibility

Works alongside `compact-mode`, `editor-info`, and the `subagents` extension.
Only the built-in tools are gated (`read`, `write`, `edit`, `grep`, `find`,
`ls`, `bash`, and `apply_patch` if present); custom extension tools are not
rewritten — they run under the same policy via `request_approval` when they
call it.
