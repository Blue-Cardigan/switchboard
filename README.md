# Switchboard

Move a conversation between Codex and Claude Code, in place, in one command.

```
in Codex:        cc      → this terminal comes back as Claude Code
in Claude Code:  !cx     → this terminal comes back as Codex
```

Both work in the same terminal pane — no new window — so they are fine inside Zed,
tmux, or anywhere else. `cc` needs no Codex credit, which is the point: it rescues a
session that has run out.

Each command does the whole job: convert the conversation, stage it against this
terminal, close the agent you are leaving, and reopen the other one on the same
conversation. Add `--no-quit` to leave the current agent running, `--print` to just see
the command, or `--window` (on `cc`) to open a new Terminal window instead.

## Install

Requires zsh, Node 18+, and whichever agents you want to switch between:
[Codex CLI](https://github.com/openai/codex) 0.150+ and/or
[Claude Code](https://docs.claude.com/en/docs/claude-code). macOS and Linux.

```
git clone https://github.com/Blue-Cardigan/switchboard.git ~/.claude/skills/switchboard
~/.claude/skills/switchboard/install.sh
```

The installer is idempotent, refuses to overwrite anything it does not own, and backs up
what it edits. It adds exactly four things:

| Path | What |
|---|---|
| `~/.local/bin/{cc,cx,cx2cc}` | symlinks to `bin/` |
| `~/.config/switchboard/codex-handoff.zsh` | symlink to `shell/` — the wrapper that reopens the other agent |
| `~/.zshrc` | one `source` line (backup: `~/.zshrc.bak-switchboard`) |
| `~/.claude/skills/switchboard` | symlink, if you cloned elsewhere, so Claude Code finds the plugin |

Then open a new terminal — the wrapper only exists in shells started after installing (see
[Older terminals](#older-terminals)) — and Claude Code loads the plugin on its next session.

You can clone anywhere; `~/.claude/skills/` just saves the installer a symlink.

## What survives the move

**Codex → Claude Code** (`cc`) rebuilds the conversation as a Claude Code transcript and
resumes it, so it loads as real history. Prompts and replies survive in full, plus a
summarised trail of the commands run and files edited; command *output* and file contents
do not, so Claude is told to re-read files rather than trust the summary. Long sessions are
trimmed to a context budget (default ~120k characters), dropping the activity trail before
the conversation and the oldest material before the newest. `--full` keeps everything;
`--budget <chars>` sets your own limit.

**Claude Code → Codex** (`cx`) uses Codex's own external-agent importer
(`externalAgentConfig/import` over `codex app-server`), so the conversion is Codex's, not
mine, and the result is a normal Codex thread. Re-importing the same transcript reuses the
thread Codex already made rather than duplicating it.

## How each side is identified

Getting the *right* session matters when several run in one directory.

- **Codex** exports `CODEX_THREAD_ID` into shell commands, so `cc` normally knows exactly
  which session it is in. Failing that it finds the Codex process that spawned the shell
  and asks `lsof` which rollout it holds open, then falls back to the newest session for
  the directory. The output names the method used.
- **Claude Code** exports nothing equivalent and does not hold its transcript open, so a
  `SessionStart` hook records which session owns which terminal. `cx` reads that, falling
  back to the newest transcript for the directory.

Note `/rollout` does **not** exist as a Codex command, despite that string appearing in the
Codex binary. Do not trust binary strings for the command list; type `/` in Codex for the
real one.

## Older terminals

The in-place switch has two halves: the agent you are leaving *stages* the handoff and
closes itself, and a shell wrapper around `codex`/`claude` *claims* it and opens the other
side. The wrapper lives in `~/.zshrc`, so it only exists in shells started after it was
installed — a terminal you opened last week has no idea it exists, and there the agent
closes and leaves you at a bare prompt.

That case is handled, not fatal. Before closing anything, `cc`/`cx` check for the wrapper
(via the `SWITCHBOARD_WRAPPER` environment variable it exports) and, if it is missing, say
so and tell you to type the same command again at the prompt:

```
Closing Codex now. This terminal's shell started before the switchboard
wrapper was installed, so it cannot reopen Claude on its own.

  >>> type  cc  at the prompt to finish the handoff. <<<
```

Typed at a shell prompt with a handoff waiting, `cc` and `cx` claim it and launch the
target instead of starting a new handoff — so the same two commands cover both halves.
Either one works at that point; the staged entry names its own destination.

A staged handoff is tied to one terminal and is single-use. It expires after 30 minutes for
the *automatic* claim, so that exiting an agent hours later cannot resurrect an abandoned
switch; claiming it by typing `cc`/`cx` ignores the age limit, because you asked for it
explicitly.

To retrofit an open terminal rather than waiting for the next one:

```
source ~/.config/switchboard/codex-handoff.zsh
```

## Other entry points

```
cx2cc list          # index recent Codex sessions
cx2cc drain         # hand off every live Codex session at once
cx2cc --here        # reboot the Codex session started in this directory
cx2cc 3             # reboot session #3 from the list
cx2cc <rollout>     # reboot a specific ~/.codex/sessions/**/rollout-*.jsonl
```

`/switchboard:import` pulls a Codex session into the Claude session you are already in,
rather than replacing anything.

---

# Routing single turns to Codex

Route turns of a **single** Claude Code conversation to Codex and back, without leaving the
session and without either side losing the thread.

```
/switchboard:switch codex --profile cheap  # your next prompts are answered by Codex
… talk normally …
/switchboard:switch claude                # back to Claude, which already read everything
```

## Why this exists

`openai/codex-plugin-cc` is the official bridge and is the better tool for reviews and
one-shot delegation (`/codex:review`, `/codex:rescue`). It does not do in-conversation
switching:

| | codex-plugin-cc | switchboard |
|---|---|---|
| Delegate one task to Codex | `/codex:rescue` | `/switchboard:ask` |
| Every subsequent turn goes to Codex | no | yes — sticky mode |
| Codex sees the Claude conversation | only via `/codex:transfer`, which exits to the Codex TUI | every turn, as an incremental delta |
| Claude sees what Codex said | printed output only | injected into context, so switching back is seamless |
| Pin a Codex profile / provider | no | `--profile`, `--model`, `--effort`, `--sandbox` |

The profile flag is the practical reason to use this: it lets Codex turns run on a cheap
provider instead of your ChatGPT/OpenAI limits.

## Commands

**`/switchboard:switch [codex|claude|toggle|status|reset]`**

| Flag | Effect |
|---|---|
| `--profile <name>` | Layers `$CODEX_HOME/<name>.config.toml` — e.g. a profile pointing at a cheaper provider |
| `--model <id>` | Overrides the model |
| `--effort <level>` | `none…xhigh`; reasoning effort |
| `--sandbox <mode>` | `read-only`, `workspace-write`, `danger-full-access` |
| `--relay verbatim\|quiet` | `verbatim` (default): Claude repeats Codex's reply as its whole response. `quiet`: the reply is printed straight to your terminal and Claude stays silent — cheaper, but the reply is not rendered as a conversation turn |
| `--fresh` | Start a new Codex thread instead of resuming |
| `--no-seed` / `--seed` | Whether to send Codex the Claude-side turns it hasn't seen |

`reset` drops the Codex thread but keeps your settings. `status` (the default) prints the
current routing.

**`/switchboard:ask <prompt>`** — one detour to Codex without changing who answers next.

## How it works

A `UserPromptSubmit` hook (`scripts/route.mjs`) inspects each prompt. If the current
directory is in codex mode **and** the prompt is not an escape (below), it runs
`codex exec` — resuming the same Codex thread each time — and writes the reply to stdout,
which Claude Code adds to Claude's context.

Context flows both ways:

- **Claude → Codex.** A cursor tracks how much of the Claude transcript Codex has seen.
  The first Codex turn gets the conversation so far; later turns get only what happened
  since, so you can bounce between the two without re-sending everything.
- **Codex → Claude.** Every Codex reply lands in Claude's context, so `/switchboard:switch
  claude` resumes with Claude already knowing what was said and done.

State lives in `~/.claude/switchboard/state/<hash of cwd>.json`, keyed by working directory
and claimed by the first session that submits a prompt there. A second session in the same
directory is not routed.

## Escape hatches

In codex mode these always reach Claude:

- anything starting `/` (slash commands — including `/switchboard:switch claude`)
- anything starting `!` (bash) or `#`
- anything starting `claude:` or `claude,`

## Failure behaviour

The router **fails open**. A crash, malformed hook payload, missing `codex` binary or
unparseable state produces no output and the prompt goes to Claude as normal; the exception
is logged to `~/.claude/switchboard/logs/route.log`. Codex errors (rate limits, provider
rejections) are surfaced as a readable message and stored in `lastError`, and mode is left
unchanged so you can fix the cause and retry.

## Caveats

- A routed turn blocks the session until Codex finishes. Progress streams to your terminal.
  The hook timeout is 900s (`hooks/hooks.json`); Codex is killed at 840s.
- Codex works in the same directory with its own sandbox/approval settings. In codex mode it
  is editing your files, not Claude.
- `codex exec resume` accepts no `--profile`, `--sandbox` or `-C`, so on resumed turns the
  profile's scalar settings are replayed as `-c key=value` overrides and the working
  directory is set on the spawned process.
- Both sides bill separately. Codex turns cost Codex credits, not Claude tokens — apart from
  the relay, which is why `--relay quiet` exists.

## Uninstall

```
~/.claude/skills/switchboard/install.sh --uninstall
```

Removes only the symlinks and the `~/.zshrc` line it added, and only if they still point at
this checkout. Staged state in `~/.claude/switchboard/` is left for you to delete.

To disable just the Claude Code plugin half:
`claude plugin disable switchboard@skills-dir`.

## Licence

MIT. See [LICENSE](LICENSE).
