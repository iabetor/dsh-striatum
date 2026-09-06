# dsh-striatum

A DeepSeek Harness **changes gatekeeper** plugin: every file change an agent makes passes through your striatum — keep it, undo it, or leave it pending.

Named after the **striatum**, the brain's action gatekeeper: it decides which intended movements the cortex lets through. In the same metaphor family as [`dsh-hippocampus`](https://github.com/iabetor/dsh-hippocampus) (memory) and [`dsh-thalamus`](https://github.com/iabetor/dsh-thalamus) (relay).

## What it does

While you work with an agent over many uncommitted turns, dsh-striatum tracks every file the agent writes or edits **per session** and lets you decide what sticks:

- **Keep** a file — confirm all its pending changes (the current content becomes the new baseline). Pure metadata; no file is rewritten.
- **Undo** a file — atomically restore it to the last kept baseline. Refused when the file was modified outside the agent (hash guard).
- **Leave it pending** — the change stays listed until you decide, across turns and restarts (persisted per session).

It does **not** depend on git commits to tell multiple rounds of edits apart: the harness session log already records the exact `tool/result` diffs, and striatum tracks them per file.

## Design (v2)

- **File-level semantics**: one pending unit per file — no per-edit/per-turn chains. Keep = whole file confirmed; Undo = whole file back to baseline.
- **UI**: a per-turn confirmation strip at the end of each chat turn (`conversation.chat.turnTail`) and a pending-changes overview strip above the composer (`conversation.input.dock`).
- **Single-session scope**: changes follow the current session.
- **Safety**: undo writes go through the host `ctx.fs` under the session sandbox (same permission model as the agent); a hash guard refuses undo when the file changed externally.

See [dsh-striatum-design.md](../dsh-striatum-design.md) for the full design.

## Status

- **M0 ✅** probe: external plugins receive `tool/result` with `meta.diffs` intact; the file is already in its after state when the event arrives; `ctx.fs`/`sandboxPolicy`/`sessions` are injectable.
- **M1 ✅** skeleton: repo + `ChangeRegistry` (pure file-level state machine) with unit tests; dual-half build.
- M2 (host capture + API + store), M3 (client UI), M4 (polish) — in progress.

## Development

```sh
pnpm install
pnpm run build   # dual-half build (node host + browser client)
pnpm run test    # vitest
pnpm run typecheck
```

## License

MIT
