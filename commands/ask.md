---
description: Send one prompt to Codex without leaving Claude — shares this conversation's context and keeps the Codex thread warm
argument-hint: "[--profile <name>] [--model <id>] [--effort <level>] [--fresh] <what to ask Codex>"
allowed-tools: Bash(node:*)
---

Run exactly this, from the current working directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/switch.mjs" ask $ARGUMENTS
```

Codex receives the Claude-side turns it has not seen yet, then the request. This does not change
which model answers subsequent prompts — it is a single detour.

Present Codex's reply to the user verbatim, attributed to Codex, and stop there. Do not
implement, re-derive, critique, or act on what Codex said unless the user asks you to next.
If the command reports a failure, quote the error rather than retrying.
