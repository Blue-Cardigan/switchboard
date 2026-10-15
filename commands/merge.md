---
description: Bring Codex threads back into Claude — append their Codex turns to the Claude conversations they came from, or import ones that began in Codex
argument-hint: "[<thread name or id>... | --imported] [--apply] [--stop-claude] [--archive] [--open]"
allowed-tools: Bash(node:*)
---

First run a dry run, from the current working directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/merge.mjs" $ARGUMENTS
```

Without `--apply` it only reports, one line per thread: how many Codex turns would be appended
to which Claude conversation, or why a thread is blocked (`Codex is mid-turn`, `Claude still has
… open`, `Claude is mid-turn`). Show the user that table.

Then, if the user asked for it to happen (not only for a report), rerun with `--apply`:

- `--stop-claude` closes Claude processes that hold a target conversation, but only ones that
  are idle. Never use it on this session's own conversation.
- `--archive` archives each merged thread in Codex, so it leaves the ChatGPT sidebar. Only pass
  it when the user wants the conversation to continue in Claude from now on.
- `--open` resumes each merged conversation in Claude desktop.

A merge is repeatable: a thread that carries on in Codex can be merged again and only the new
turns are appended. Every appended transcript is backed up first under
`~/.claude/switchboard/backups/`.
