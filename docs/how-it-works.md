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

## Notes

- `/rollout` does **not** exist as a Codex command, despite that string appearing in the
  Codex binary. Do not trust binary strings for the command list; type `/` in Codex for the
  real one.
- Claude Code will resume a hand-written transcript, which is what makes Codex → Claude
  possible at all.
- Consecutive same-role turns are merged on import, so a long Codex session can arrive as
  noticeably fewer, longer turns than it had.
