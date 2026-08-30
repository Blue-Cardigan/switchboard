# Switchboard

Move a conversation between Codex and Claude Code. In place, in one command.

```
!cc   in Codex          → this terminal comes back as Claude Code
!cx   in Claude Code    → this terminal comes back as Codex
```

Same terminal pane, no new window, so it works in Zed, tmux or anywhere else. `!cc` needs
no Codex credit — rescuing a session that has run out is the point.

Each command converts the conversation, closes the agent you are leaving, and reopens the
other one on it. `--alongside` keeps both instead: the other agent opens in a tmux split,
or a new tab or window, and nothing closes. `--no-quit` stages the switch without closing
anything; `--print` just shows the resume command.

## Requirements

zsh, Node 18+, and [Codex](https://github.com/openai/codex) 0.150+ and/or
[Claude Code](https://docs.claude.com/en/docs/claude-code). macOS and Linux.

## Install

```bash
git clone https://github.com/Blue-Cardigan/switchboard.git ~/.claude/skills/switchboard
~/.claude/skills/switchboard/install.sh
```

Then open a new terminal. Clone wherever you like — the path above just saves a symlink.

The installer is idempotent, backs up what it edits, and refuses to overwrite anything it
does not own. It adds `~/.local/bin/{cc,cx,cx2cc}`,
`~/.config/switchboard/codex-handoff.zsh`, one `source` line in `~/.zshrc`, and a
`~/.claude/skills/switchboard` symlink so Claude Code finds the plugin.

## What survives

**Codex → Claude Code** rebuilds the conversation as a Claude Code transcript and resumes
it, so it loads as real history: prompts and replies in full, plus a summary of commands
run and files edited. Command output and file contents do not survive, so Claude is told to
re-read files rather than trust the summary. Long sessions are trimmed to ~120k characters
(`--full`, or `--budget <chars>`).

**Claude Code → Codex** uses Codex's own importer, so the result is an ordinary Codex
thread. Re-importing the same conversation reuses that thread instead of duplicating it.

## Claude desktop

Claude desktop's local agent mode writes ordinary Claude Code transcripts, so those
conversations can go to Codex too:

```bash
cx --desktop      # list them
cx --desktop 2    # hand conversation 2 to Codex, opened alongside
```

The transcript is copied into `~/.claude/projects` on the way through — Codex imports only
from there — which also makes it resumable with `claude --resume`. `--cwd DIR` resumes
somewhere other than the session's own sandbox.

The ChatGPT desktop app disables its own `/import` while it is attached to the local
app-server daemon, which is why the sync appears to run once and then never again. This is
the way round that. Threads created this way may not show in the app's list; `codex resume`
always finds them.

## If nothing reopens

The switch has two halves: the agent you leave stages the handoff, and a shell wrapper
reopens the other side. That wrapper is added to `~/.zshrc`, so it only exists in shells
started after you installed — in an older terminal the agent closes and leaves you at a
prompt.

`!cc` and `!cx` check for this *before* closing anything and tell you what to do: **type
`cc` or `cx` at the prompt** — no `!`, you are in the shell now — and the handoff
completes. To retrofit a terminal instead:
`source ~/.config/switchboard/codex-handoff.zsh`.

A staged handoff belongs to one terminal and is single-use.

## Also

```bash
cx2cc list      # index recent Codex sessions
cx2cc drain     # hand off every live Codex session at once
cx2cc 3         # reboot session #3 from the list
```

`/switchboard:import` pulls a Codex session into the Claude session you are already in,
instead of replacing it.

`/switchboard:switch` routes your next prompts to Codex and back without leaving the
conversation — see [docs/routing.md](docs/routing.md).

[docs/how-it-works.md](docs/how-it-works.md) covers session identification and the rest of
the internals.

## Uninstall

```bash
~/.claude/skills/switchboard/install.sh --uninstall
```

Removes only what it added, and only while it still points at this checkout.

MIT.
