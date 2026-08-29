# Routing single turns to Codex

Route turns of a **single** Claude Code conversation to Codex and back, without leaving the
session and without either side losing the thread.

```
/switchboard:switch codex --profile cheap   # your next prompts are answered by Codex
… talk normally …
/switchboard:switch claude                  # back to Claude, which already read everything
```

`/switchboard:ask <prompt>` is one detour to Codex without changing who answers next.

## Why not codex-plugin-cc

[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) is the official bridge
and the better tool for reviews and one-shot delegation. It does not do in-conversation
switching:

| | codex-plugin-cc | switchboard |
|---|---|---|
| Delegate one task | `/codex:rescue` | `/switchboard:ask` |
| Every later turn goes to Codex | no | yes — sticky mode |
| Codex sees the Claude conversation | via `/codex:transfer`, which exits to the Codex TUI | every turn, as an incremental delta |
| Claude sees what Codex said | printed output only | injected into context |
| Pin a profile / provider | no | `--profile`, `--model`, `--effort`, `--sandbox` |

The profile flag is the practical reason to use it: Codex turns can run on a cheap provider
instead of your ChatGPT limits.

## Flags

`/switchboard:switch [codex|claude|toggle|status|reset]`

| Flag | Effect |
|---|---|
| `--profile <name>` | Layers `$CODEX_HOME/<name>.config.toml` |
| `--model <id>` | Overrides the model |
| `--effort <level>` | `none`…`xhigh` |
| `--sandbox <mode>` | `read-only`, `workspace-write`, `danger-full-access` |
| `--relay verbatim\|quiet` | `verbatim` (default): Claude repeats Codex's reply as its response. `quiet`: printed straight to your terminal, Claude stays silent — cheaper, but not rendered as a conversation turn |
| `--fresh` | Start a new Codex thread instead of resuming |
| `--no-seed` / `--seed` | Whether to send Codex the Claude turns it has not seen |

`reset` drops the Codex thread but keeps your settings. `status` (the default) prints the
current routing.

## How it works

A `UserPromptSubmit` hook (`scripts/route.mjs`) inspects each prompt. If the directory is in
codex mode and the prompt is not an escape, it runs `codex exec` — resuming the same thread
each time — and writes the reply to stdout, which Claude Code adds to Claude's context.

Context flows both ways. A cursor tracks how much of the Claude transcript Codex has seen,
so the first Codex turn gets the conversation so far and later turns get only the delta.
Every Codex reply lands in Claude's context, so switching back is seamless.

State lives in `~/.claude/switchboard/state/<hash of cwd>.json`, keyed by working directory
and claimed by the first session to submit a prompt there. A second session in the same
directory is not routed.

**Escapes.** In codex mode these always reach Claude: anything starting `/`, `!`, `#`,
`claude:` or `claude,`.

**Failure.** The router fails open: a crash, bad payload, missing `codex` binary or
unparseable state produces no output and the prompt goes to Claude as normal, with the
exception logged to `~/.claude/switchboard/logs/route.log`. Codex errors are surfaced as a
message and stored in `lastError`, leaving mode unchanged.

## Caveats

- A routed turn blocks the session until Codex finishes; progress streams to your terminal.
  The hook timeout is 900s and Codex is killed at 840s.
- In codex mode Codex is editing your files, not Claude, under its own sandbox settings.
- `codex exec resume` accepts no `--profile`, `--sandbox` or `-C`, so on resumed turns the
  profile's scalar settings are replayed as `-c key=value` and the working directory is set
  on the spawned process.
- Both sides bill separately. Codex turns cost Codex credits, not Claude tokens — apart from
  the relay, which is why `--relay quiet` exists.
