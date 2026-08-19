# editor-info

Custom pi editor shell:

```text
──────────────────── gpt-5.4 fast • xhigh • ▰▰▱▱▱▱▱▱▱▱ 12.3%/128K • 2.0K tok/s
❯ Type a prompt here
─────────────────────────────────────────────────────────────────────────────
```

- Top and bottom borders use the fixed neutral-gray `muted` theme color. They do not
  change with thinking level.
- Pi's built-in footer is replaced with an empty component because its model,
  context, token, cost, and directory information is redundant with the editor
  border. It is restored automatically when the extension shuts down.
- `❯` is the input-start marker.
- Submitted user messages keep pi's existing `userMessageBg` box and add the
  same accent-colored `❯ ` prompt inside it. Wrapped and multiline content uses
  a two-column continuation indent.
- Top-right information order is model, thinking level, context usage, and
  current-model token throughput.
- Context usage uses a modern segmented `▰/▱` progress bar with no `ctx`
  prefix. It displays only percentage and total context-window size, for
  example `▰▰▰▰▰▰▱▱▱▱ 63.7%/128K`.
- GPT model labels append `fast` only while fast mode is active, read from
  `@pi-plugins/fast-mode`'s shared status registry. No fast label is shown when
  the mode is off.
- The redundant `[fast mode]` row above the editor is filtered out while the
  registry data remains available for the top-border `fast` label.
  Other extensions using the shared `pi-plugins:statusline` row are preserved.
- Throughput is time-weighted across the last eight completed assistant
  messages, with a live estimate while streaming, and resets on model change.
- All normal `CustomEditor` behavior remains available: history, multiline
  input, autocomplete, paste markers, IME cursor placement, and app keybindings.
