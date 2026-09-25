# How the handoff works

## Identifying the session

Getting the *right* session matters when several run in one directory.

- **Codex** exports `CODEX_THREAD_ID` into shell commands, so `!cc` normally knows exactly
  which session it is in. Failing that it finds the Codex process that spawned the shell and
  asks `lsof` which rollout it holds open, then falls back to the newest session for the
  directory. The output names the method used.
- **Claude Code** exports nothing equivalent and does not hold its transcript open, so a
  `SessionStart` hook records which session owns which terminal. `!cx` reads that, falling
  back to the newest transcript for the directory.

## Staging and claiming

The agent being left writes `~/.claude/switchboard/pending/<tty>.json` naming its target,
then closes itself with a detached `kill -TERM` — detached so the dying process cannot take
the staging command with it.

The shell wrapper around `codex`/`claude` claims that entry when the agent exits and `exec`s
the other one. Entries are single-use and expire after 30 minutes, so exiting an agent hours
later cannot resurrect an abandoned switch. Claiming by typing `cc`/`cx` at a prompt ignores
the age limit, since you asked for it explicitly.

The wrapper only claims entries meant for it — `codex()` takes `claude` targets and vice
versa — so the two never steal each other's handoffs.

It also declines to claim anything for a non-interactive run: `codex exec`, `claude -p`,
`--version`, and the management subcommands of both. Those are used inside scripts and by
other agents, and replacing that shell with an agent TUI would take over a terminal nobody
is watching. Routed turns set `SWITCHBOARD_ROUTED=1`, which the wrapper also honours.

The wrapper's reload is written inline in `codex()` and `claude()` rather than in a helper.
Some environments — Claude Code's own bash tool among them — replay captured shell functions
selectively, keeping the wrappers and dropping everything underscore-prefixed, and a helper
that is missing cannot restore itself.

## Claude desktop sessions

Claude desktop's local agent mode runs each conversation in its own sandbox under
`~/Library/Application Support/Claude/local-agent-mode-sessions/`, and inside that sandbox
it writes a normal Claude Code transcript. A `local_<id>.json` sidecar beside each sandbox
gives the title and names the transcript, which is what `cx --desktop` lists.

The copy is also what makes a desktop conversation resumable in the CLI, which is what
`cc --desktop` does. That direction rewrites the `cwd` recorded on each row, so Claude Code
is not reading a sandbox path it is not running in; the Codex direction leaves the bytes
untouched, because its ledger dedupes on a content hash.

Codex will only import Claude sessions it finds under `~/.claude/projects`. Handed a path
outside that, `externalAgentConfig/import` does not error — it ignores the request and
imports its own default set instead, which is how you end up with a thread that is not the
conversation you asked for. So the desktop transcript is copied into `~/.claude/projects`
first, and the import is checked against Codex's ledgers by path *and* content hash.

There are two of those ledgers, both in `~/.codex`: `external_agent_session_imports.json`
for the CLI importer and `claude-cowork-import-history.json` for the desktop app's sync.
Both are consulted, so an import the ChatGPT app already did is reused rather than repeated.
An import is only reused while the content hash still matches; a conversation that has grown
since is imported again.

## ChatGPT desktop threads, and what Claude desktop lists

The ChatGPT desktop app uses `~/.codex` as its home, so its threads sit in the same rollout
store the CLI writes to and `cc` can already convert them. What the app adds is names, in
`~/.codex/session_index.jsonl` — one append per rename, so the last entry for an id wins.
That is where the names in `cx2cc list` come from, and why a thread can be selected by name.

Claude desktop lists *running* Claude Code sessions, not stored transcripts. Every live
session registers itself in `~/.claude/sessions/<pid>.json` with its `sessionId`, `cwd`, a
`messagingSocketPath` under `/tmp/cc-socks/`, and an `entrypoint` of `cli` or
`claude-desktop`; the app reads that registry. So a conversation brought over from Codex
appears in Claude desktop once it is actually resumed and running — importing the transcript
alone is not enough.

## Transcripts switchboard wrote

Every transcript switchboard writes is recorded in `~/.claude/switchboard/authored.json`
with its size and mtime. A file that still matches its record is *pristine*: switchboard
wrote it and nobody has resumed it.

That distinction matters twice. `cx` picks the newest transcript for a directory as "this
conversation", and an unresumed import sitting in the same directory would otherwise be
picked, handing Codex back its own words. And a desktop session already copied and then
continued is left alone rather than refreshed, which would discard the turns added since.

## Notes

- `/rollout` does **not** exist as a Codex command, despite that string appearing in the
  Codex binary. Do not trust binary strings for the command list; type `/` in Codex for the
  real one.
- Claude Code will resume a hand-written transcript, which is what makes Codex → Claude
  possible at all.
- Consecutive same-role turns are merged on import, so a long Codex session can arrive as
  noticeably fewer, longer turns than it had.

## Opening a session beside the one you are in

`--alongside` tries, in order: a tmux split, a new tab in Zed's integrated terminal, an
iTerm tab, a Terminal.app window, then the usual Linux terminals. Each returns a short
description, and `null` means nothing here could be driven, so the caller prints the resume
command instead.

Zed is the odd one out. Its CLI cannot open a terminal, so switchboard drives the editor's
own `workspace::NewTerminal` binding (`ctrl-shift-\``) through System Events and types the
path of a staged one-shot script into the tab that opens — typing a path is far more
reliable than keystroking a whole command line. The script `cd`s, execs the agent and
deletes itself; anything never typed is swept after an hour. This needs Accessibility and
Automation permission, and macOS prompts for both the first time. Without them osascript
exits non-zero, `openInZed` returns false, and the next fallback takes over.

## Forking a conversation

`cc --alongside` inside Claude Code copies the running transcript to a new session id and
opens that. Rows are copied verbatim rather than rebuilt, so tool calls and images survive
and the fork inherits the parent's model unless `--model` overrides it. `sessionId`,
`session_id` and `cwd` are rewritten per row; the copy is recorded in `authored.json`, which
keeps an unresumed fork from being mistaken for "the conversation running here" later.
