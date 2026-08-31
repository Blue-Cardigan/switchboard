# Routing single turns to the other agent

Route turns of a **single** conversation to the other agent and back, without leaving the
session and without either side losing the thread. It works from either end.

From inside Claude Code:

```
/switchboard:switch codex --profile cheap   # your next prompts are answered by Codex
… talk normally …
/switchboard:switch claude                  # back to Claude, which already read everything
```

From inside Codex, once `./install.sh --codex-hooks` has been run:

```
!cx2cc switch claude       # your next prompts are answered by Claude Code
… talk normally …
!cx2cc switch codex        # back to Codex, which already read everything
```

`/switchboard:ask <prompt>` — or `!cx2cc switch ask <prompt>` — is one detour to the other
agent without changing who answers next.

## Turning on the Codex side

The Claude Code half installs itself: it is a plugin hook, and the plugin is a symlink the
installer makes. The Codex half is opt-in, because it writes into `~/.codex/hooks.json`,
which is your file and may already hold hooks of your own:

```bash
./install.sh --codex-hooks     # merges one UserPromptSubmit entry, backing the file up
./install.sh --uninstall       # takes it back out
```

Codex asks you to trust a new hook the first time it runs. Nothing is routed until you say
yes, and nothing changes in directories you never switch.

## Why not codex-plugin-cc

[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) is the official bridge
and the better tool for reviews and one-shot delegation. It does not do in-conversation
switching:

| | codex-plugin-cc | switchboard |
|---|---|---|
| Delegate one task | `/codex:rescue` | `/switchboard:ask` |
| Every later turn goes to Codex | no | yes — sticky mode |
| Route the other way, Codex → Claude | no | yes — same hook, mirrored |
| Codex sees the Claude conversation | via `/codex:transfer`, which exits to the Codex TUI | every turn, as an incremental delta |
| Claude sees what Codex said | printed output only | injected into context |
| Pin a profile / provider | no | `--profile`, `--model`, `--effort`, `--sandbox` |

The profile flag is the practical reason to use it: Codex turns can run on a cheap provider
instead of your ChatGPT limits.

## Flags

`/switchboard:switch [codex|claude|toggle|status|reset]`, or `!cx2cc switch …` with the same
verbs. `on` and `off` also work and are read relative to whichever agent you are typing into.

| Flag | Effect | Applies to |
|---|---|---|
| `--profile <name>` | Layers `$CODEX_HOME/<name>.config.toml` | Codex turns |
| `--model <id>` | Overrides the model | both |
| `--effort <level>` | `none`…`xhigh` | Codex turns |
| `--sandbox <mode>` | `read-only`, `workspace-write`, `danger-full-access` | Codex turns |
| `--permission-mode <mode>` | Passed to `claude -p`, e.g. `acceptEdits`, `plan` | Claude turns |
| `--relay verbatim\|quiet` | `verbatim` (default): the host agent repeats the reply as its response. `quiet`: printed straight to your terminal, the host stays silent — cheaper, but not rendered as a conversation turn | both |
| `--fresh` | Start a new thread on the other side instead of resuming | both |
| `--no-seed` / `--seed` | Whether to send the other agent the turns it has not seen | both |
| `--harness claude\|codex` | Which side you are typing into. Detected from the process tree; this overrides it | both |

`reset` drops the other agent's thread but keeps your settings. `status` (the default)
prints the current routing.

## How it works

A `UserPromptSubmit` hook inspects each prompt. If the directory is switched and the prompt
is not an escape, the hook runs the other agent and feeds the reply back into the host's
context. Codex 0.151 takes the same `hooks.json` shape and the same `UserPromptSubmit`
payload as Claude Code, so the two directions are the same design mirrored:

| | Claude Code host | Codex host |
|---|---|---|
| Hook script | `scripts/route.mjs` | `scripts/route-codex.mjs` |
| Runs | `codex exec resume` | `claude -p --resume --output-format stream-json` |
| Reads the host's turns from | the Claude transcript, by line | the Codex rollout, by byte offset |
| Returns the reply as | stdout | `hookSpecificOutput.additionalContext` |
| Registered by | the plugin, automatically | `./install.sh --codex-hooks` |

Context flows both ways. A cursor tracks how much of the host conversation the other agent
has seen, so its first turn gets the conversation so far and later turns get only the delta.
Every reply lands in the host's context, so switching back is seamless.

State lives in `~/.claude/switchboard/state/<hash of cwd>.json` for a Claude host and
`<hash of cwd>-codex.json` for a Codex one — keyed by working directory, claimed by the
first session to submit a prompt there. A second session in the same directory is not
routed, and a Codex session and a Claude session in the same directory do not read each
other's mode.

**No ping-pong.** Both runners export `SWITCHBOARD_ROUTED=1`, and both routers return
immediately when they see it. Without that, a routed turn would trigger the other router and
the prompt would bounce between them.

**Escapes.** These always reach the host agent: anything starting `/`, `!`, `#`, or the
host's own name and a colon — `claude:` in codex mode, `codex:` in claude mode.

**Failure.** Both routers fail open: a crash, bad payload, missing binary or unparseable
state produces no output and the prompt goes to the host agent as normal, with the exception
logged to `~/.claude/switchboard/logs/route.log` or `route-codex.log`. Errors from the other
agent are surfaced as a message and stored in `lastError`, leaving mode unchanged.

## Caveats

- A routed turn blocks the session until the other agent finishes; progress streams to your
  terminal. The hook timeout is 900s and the child is killed at 840s.
- In codex mode Codex is editing your files, not Claude, under its own sandbox settings —
  and in claude mode the reverse, under `--permission-mode`.
- `codex exec resume` accepts no `--profile`, `--sandbox` or `-C`, so on resumed turns the
  profile's scalar settings are replayed as `-c key=value` and the working directory is set
  on the spawned process.
- Both sides bill separately. Codex turns cost Codex credits, not Claude tokens — apart from
  the relay, which is why `--relay quiet` exists.
