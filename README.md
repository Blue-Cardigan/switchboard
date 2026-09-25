# Switchboard

Move a conversation between Codex and Claude Code. In place, in one command.

```
!cc   in Codex          → this terminal comes back as Claude Code
!cx   in Claude Code    → this terminal comes back as Codex
```

Same terminal pane, no new window, so it works in Zed, tmux or anywhere else. `!cc` needs
no Codex credit — rescuing a session that has run out is the point.

Each command converts the conversation, closes the agent you are leaving, and reopens the
other one on it. `--alongside` keeps both instead: the other agent opens in a tmux split, a
new tab in the editor's own terminal (Zed), or a new terminal tab or window — and nothing
closes. `--no-quit` stages the switch without closing
anything; `--print` just shows the resume command.

## Side chats

Inside Claude Code, `cc --alongside` duplicates **this** conversation rather than fetching
another one: a second session opens beside it with everything the first one knows, and both
keep running.

```bash
cc --alongside            # fork this conversation into a side chat
cc --fork --model claude-haiku-4-5   # …and answer it with a cheaper model
cc --fork --print         # just show the resume command
```

The copy is the transcript, row for row — tool calls and all — so the fork is the
conversation, not a summary of it. The two diverge from that point; nothing merges them back.

`cc` with a Codex session named (`cc 3`, `cc --last`, `cc "thread name"`) still brings that
one over, and `cx --alongside` still opens the same conversation in Codex beside you.

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
conversations can be picked up from either CLI:

```bash
cx --desktop      # list them
cx --desktop 2    # hand conversation 2 to Codex, opened alongside
cc --desktop 2    # resume conversation 2 here, in Claude Code
```

The transcript is copied into `~/.claude/projects` on the way through — Codex imports only
from there — which also makes it resumable with `claude --resume`. `--cwd DIR` resumes
somewhere other than the session's own sandbox; `cc --desktop` rewrites the recorded working
directory to match, and never overwrites a copy you have since added turns to.

There is no route back into Claude desktop: its conversation list is server state, not
something on disk.

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
cx2cc list           # index recent Codex sessions, named ones first-class
cx2cc drain          # hand off every live Codex session at once
cx2cc 3              # reboot session #3 from the list
cc "Review ticket"   # or pick a ChatGPT thread by its name
```

Threads from the ChatGPT desktop app share Codex's session store, so they are listed and
selectable by the name the app shows. Bringing one over starts a normal Claude Code session,
which the Claude desktop app lists alongside its own while it is running.

Nothing has to be replaced, either. From inside Claude Code:

```bash
cx --context       # print the conversation, to paste into Codex yourself
cx --queue         # push it into the Codex session already running here
cx --queue <id>    # …or into one named by id or session name
```

`--queue` uses `codex queue`, so the transcript lands in a Codex TUI that is already open,
on its next turn. Claude Code keeps running either way. `cx2cc context` is the same thing in
the other direction.

`/switchboard:import` pulls a Codex session into the Claude session you are already in,
instead of replacing it.

`/switchboard:switch` (or `!cx2cc switch` inside Codex) routes your next prompts to the other
agent and back without leaving the conversation. It works from both ends; the Codex side is
one opt-in step, because it writes to `~/.codex/hooks.json`:

```bash
./install.sh --codex-hooks
```

See [docs/routing.md](docs/routing.md).

[docs/how-it-works.md](docs/how-it-works.md) covers session identification and the rest of
the internals.

## Uninstall

```bash
~/.claude/skills/switchboard/install.sh --uninstall
```

Removes only what it added, and only while it still points at this checkout.

MIT.
