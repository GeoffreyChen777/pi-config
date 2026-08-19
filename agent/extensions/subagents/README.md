# subagents — generic multi-agent messaging extension

> Status: fully implemented and verified end-to-end
> Design principle: **generic messaging at the bottom layer, identity defined by prompts**

## Core design

**Bottom layer (generic, no identity concept)**:
- Two parties communicate: `main` (the main agent) and any subagent.
- Message primitives: `send_message` / `read_inbox` / `reply_message`.
- Routing: `to=main` -> inject into the main session; `to=<subagent>` -> forward to its resident process.
- File channel + polling (no process pipes, no identity required).

**Identity (prompt layer)**:
- `agents/*.md`: defines each subagent's identity, duties, model, tools (e.g. planner/reviewer/actor).
- `orchestrator.md`: defines the main agent's triage identity (optional injection).
- The bottom layer never cares who is who — it only delivers messages.

## Messaging tools (shared by all agents)

| Tool | Purpose |
|---|---|
| `send_message({to, content, wait, timeoutSeconds?})` | Send a message to any target; wait=true blocks for and returns the reply |
| `read_inbox()` | Read messages others sent you |
| `reply_message({message_id, content})` | Reply to a received message |

`to` is either `main` (the main agent) or any subagent name.

## Features

- **Delegation**: `subagent` tool (sync / background `async:true`); background results are injected into the main session when done.
- **Real-time two-way**: subagent<->main and subagent<->subagent, via file channel + resident RPC process pool.
- **Non-blocking**: background tasks do not occupy the main session.
- **Default safety gate**: unless the current user explicitly requests subagent involvement or `/orchestrate` is enabled, the main-agent system prompt forbids subagent delegation.
- **Bounded execution**: one-shot and resident tasks have configurable timeouts (default 6 hours, maximum 3 days); omit `timeoutSeconds` unless the user explicitly requested a time. Timed-out or crashed resident processes are discarded before the next task.
- **Reliable messaging**: `send_message(wait=true)` waits for and returns the target's actual reply; `wait=false` remains fire-and-forget.
- **Compact transcript events**: incoming messages and background completion/failure results use transparent, icon-led Markdown renderers instead of the default colored custom-message box or a synthetic user message.
- **Session isolation**: message channels use the real pi session id instead of a shared `ephemeral` directory.
- **Running widget**: while subagents are active, a compact widget above the editor shows their names, elapsed times, execution mode, and a shortened task/message summary; it disappears automatically when the last activity finishes.
- **Session navigation**: Shift+Up/Down selects a running subagent, Enter opens the exact RPC session behind that activity, and Esc returns to main while the subagent keeps running.

## Running subagent widget

The TUI-only widget is installed above the editor while at least one subagent is running:

```text
 ⠋ Subagents · 2 running · ⇧+↑/↓ select · Enter open
 › actor [bg] · 12s · Implement the login flow and run tests…
 └ reviewer [msg] · 4s · Review the current changes…
```

- No suffix: synchronous `subagent` task.
- `[bg]`: background `subagent(async=true)` task.
- `[msg]`: resident task started through `send_message` or subagent-to-subagent routing.
- At most four activities are shown; additional concurrency is summarized as `… +N more`, and the visible window follows the selected activity.
- Task summaries are dimmed and capped at 40 terminal columns so they do not dominate the widget.
- The title includes dim keyboard hints. Before selection it shows
  `⇧+↑/↓ select · Enter open`; with an active selection it changes to
  `⇧+↑/↓ move · Enter open · Esc clear`. Narrow terminals progressively shorten
  the hint and hide it when the title itself needs the space.
- The elapsed time and spinner refresh while work is active.
- Normal completion, failure, timeout, cancellation, crash, and session shutdown all remove the matching activity. The widget itself is removed when no activities remain.
- JSON/RPC/print modes do not install the widget.

### Keyboard navigation

- `Shift+Down`: select the first activity, then move down (wraps).
- `Shift+Up`: select the last activity, then move up (wraps).
- `Enter`: open the selected subagent session.
- `Esc`: clear widget selection.
- Without a selected activity, normal Enter/arrow input remains owned by the main editor.
- Duplicate Shift+arrow reports arriving within 150ms are coalesced, preventing terminals that emit the same physical keypress more than once from skipping activities.

The session view is a focused overlay connected to the exact process/session
that is running the selected task—not a new conversation with another copy of
the same agent.

The overlay uses 96% of the terminal width and 85% of its height (with no outer margin).
Its transcript viewport grows with terminal height instead of being fixed to a
small number of rows.

```text
╭──────────────────────── actor session · working… ────────────────────────╮
│ Initial delegated task                                                    │
│                                                                            │
│ ⠋ tool calling...                                                         │
│ └  ⠋ bash npm test (4.2s)                                                 │
│                                                                            │
│ Working on the implementation…                                            │
│                                                                            │
│ › additional instruction                                                   │
│ Enter send · Esc main · Ctrl+O expand · PgUp/PgDn scroll                  │
╰────────────────────────────────────────────────────────────────────────────╯
```

- Enter sends a prompt when idle or a steering message while streaming.
- Esc closes only the overlay and returns focus to main; the subagent continues.
- Ctrl+X aborts the selected subagent's current operation.
- Ctrl+O expands/collapses every compact thinking/tool block.
- PageUp/PageDown scroll the transcript; End returns to live output.
- History is loaded on entry and early streaming events are buffered to avoid a startup race.
- Tool calls show their arguments, streaming output, and final `[done]`/`[error]` status. Accumulated progress updates are converted to new output only, so previously shown lines are not duplicated.
- User and assistant messages use pi's normal Markdown styling. Assistant fenced code blocks use compact-mode's bordered syntax-highlighted rendering.
- Thinking and consecutive tool calls are merged into isolated compact-mode blocks with the same rails, colors, token estimates, collapsed limits, expanded result previews, and visible-text boundaries as the main transcript.
- If Enter is pressed before the RPC process is ready, the requested session opens automatically as soon as its handle becomes available.

## Main transcript message rendering

Subagent-originated events use transparent backgrounds with one column of left
padding. Protocol metadata stays in the underlying model message but is hidden
from the visible transcript:

```text
 ← reviewer [msg] • reply requested
 │ Please verify the cancellation behavior.
 └ Include the timeout recovery case.

 ✓ actor [bg] • completed · 42s
 │ Implemented and tested the requested changes.
 └ All checks pass.

 ✗ planner [bg] • failed · 10s
 └ Subagent timed out after 10 seconds.
```

- `←` marks a message entering the main session.
- `✓` and `✗` mark background completion and failure.
- A dim `│` rail marks every body row and changes to `└` on the final row,
  making each subagent event's exact transcript range immediately visible.
- Agent names are emphasized; `[msg]` / `[bg]`, status, and elapsed time remain compact.
- Message bodies render as Markdown and reuse compact-mode's bordered,
  syntax-highlighted fenced-code style.
- Visible rows omit message IDs, routing paths, run IDs, and
  `reply_message` protocol instructions.
- Fire-and-forget messages do not ask the main agent to call `reply_message`;
  their request files are removed immediately after successful injection.
- Background results are delivered as custom messages with
  `triggerTurn: true` and `deliverAs: "steer"`, preserving the former
  synthetic-user-message behavior without inheriting `userMessageBg`.

## Architecture

```
Main agent (identity: orchestrator triage, defined by prompt)
  |
  |-- subagent tool (sync/background spawns an RPC-backed run session)
  |     `-- widget selection / interactive overlay attach to that exact session
  |-- RPC resident process pool (receives inter-subagent messages)
  |-- message router (500ms poll)
  |     |-- to=main     -> inject into main session -> reply_message replies
  |     |-- to=subagent -> route to its resident process -> reply written back
  |
Subagents (separate processes, child mode):
  |-- send_message / read_inbox / reply_message tools
  |-- file channel: /tmp/pi-subagents-messages/<session>/<run>/<agent>/<idx>/{requests,replies}/
```

## Layout

```
subagents/
|-- package.json
|-- index.ts        # main (subagent tool + message router + background) / child (messaging tools)
|-- agents.ts       # agent discovery (frontmatter parsing)
|-- agents/*.md     # subagent identity definitions (planner / reviewer / actor)
|-- spawn.ts        # RPC-backed interactive runs + legacy JSON one-shot compatibility
|-- pool.ts         # RPC resident process pool (inter-subagent message routing)
|-- message.ts      # generic messaging (file channel + send/reply/read + main-side router)
|-- session.ts      # common interactive session-handle interface
|-- session-ui.ts   # focused overlay for live transcript + interactive input
|-- orchestrator.md # main-agent triage prompt (optional injection)
`-- README.md
```

## Usage

```bash
# optional: inject the main-agent triage identity
pi --append-system-prompt ~/.pi/agent/extensions/subagents/orchestrator.md

# or in-session
/orchestrate            # enable orchestrator mode (injects the triage identity every turn)
/orchestrate off        # disable
/orchestrate status     # check state

# in conversation
"Analyze /path and produce an implementation plan"   # main agent triages and may delegate
"Use subagent async=true, agent=actor, task=..."     # explicit background delegation
"Use subagent agent=reviewer timeoutSeconds=120 ..." # override the default 6h task timeout (only when the user asked)
"Have reviewer review the recent changes"            # main agent delegates to reviewer
```
