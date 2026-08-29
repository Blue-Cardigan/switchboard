---
description: Pull a Codex session into this conversation, so Claude can carry on work that started in Codex
argument-hint: "[list | --here | --last | <number> | <session-id-prefix>]"
allowed-tools: Bash(node:*)
---

Run exactly this, from the current working directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/import.mjs" context $ARGUMENTS
```

If the user passed no argument, or passed `list`, run `list` instead of `context` and show them the
numbered sessions so they can choose. `--here` picks the Codex session started in this directory;
`--last` picks the most recent one anywhere.

When you get a conversation back:

- Read it as context you are inheriting, not as your own past work. The assistant turns were
  written by Codex.
- Reply with a short orientation — what that session was doing, where it got to, and what the
  obvious next step is. Do not replay the transcript back to the user; they were there.
- Only summaries of Codex's shell commands and edits survive the import, not their output, so
  re-read any file before relying on its contents.

If the user instead wants a fresh Claude session that *is* that conversation (rather than pulling
it into this one), tell them to quit and run `cx2cc --here` — that boots Claude Code with the
Codex history loaded as real conversation history.
