---
description: Route this conversation's turns to Codex or back to Claude, keeping shared context both ways
argument-hint: "[codex|claude|toggle|status|reset] [--profile <name>] [--model <id>] [--effort <level>] [--sandbox <mode>] [--relay verbatim|quiet] [--fresh] [--no-seed]"
allowed-tools: Bash(node:*)
---

Run exactly this, from the current working directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/switch.mjs" $ARGUMENTS
```

Then print the command's output to the user verbatim and stop. Do not add commentary, do not
act on the previous conversation, and do not answer any pending question — switching who
answers is the whole task for this turn.

If no arguments were given, the script reports current status; that is the correct behaviour,
not an error.

Context for interpreting the result:

- `codex` mode means the **next** prompts the user types are answered by Codex instead of you.
  The router is a `UserPromptSubmit` hook, so nothing changes until the user submits their next
  prompt.
- Slash commands, `!` bash lines, and prompts beginning `claude:` always reach you, even in
  codex mode. That is the escape hatch if Codex is mid-thread.
- Codex's replies are injected into your context, so once the user switches back you already
  know what was said and what changed on disk.
