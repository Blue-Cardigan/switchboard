# Adding a harness

Switchboard used to branch on "Codex or Claude Code?" at every call site. It now asks a
registry, so a third harness is a file in `scripts/lib/harness/` rather than an edit
everywhere.

## The interface

A harness module default-exports one object:

```js
{
  id, label, bin,
  capabilities: { read, write, resume, fork, headless, hooks },
  resumeArgv(sessionId),          // argv that reopens a conversation
  live(cwd),                      // the conversation running here → {id, source, cwd, via}
  list({ cwd, limit }),           // conversations it knows about
  async read(session, opts),      // → { entries, meta, counts, trimmed, preamble }
  async write({ entries, cwd, preamble }),  // → a resumable conversation in THIS harness
  fork({ source, cwd, model }),   // duplicate in place, if capabilities.fork
  hostEnv(),                      // are we running inside one right now?
}
```

Register it in `scripts/lib/harness/index.mjs`. Nothing else has to change for
`--alongside`, the staged-handoff claim, and `--print` to work with it, because all three
now go through `resumeArgv`.

## What each capability costs you if it is false

- **read** — conversations cannot leave it. It can still be a destination.
- **write** — nothing can be moved *into* it. Codex is a near miss here: it writes only
  through its own importer, which reads a Claude Code transcript from inside
  `~/.claude/projects`, so `write` round-trips through that.
- **fork** — no side chats in the same harness. Falls out of `write`: Codex cannot
  duplicate a thread without the round trip, so it declares `fork: false` and `cc --fork`
  says so rather than silently doing something else.
- **hooks** — no turn-level routing (`/switchboard:switch`). Handoff still works.
  Both Codex 0.151+ and Gemini CLI use Claude Code's hook vocabulary, so a router for
  one is close to a router for the next.

## Identifying the live conversation

This is the part that differs most, and it is worth checking before writing an adapter:

- **Codex** exports `CODEX_THREAD_ID`, and each process holds its rollout file open, so
  ancestry plus `lsof` identifies the session exactly.
- **Claude Code** exports neither. A `SessionStart` hook records terminal → session, and
  the fallback is the newest transcript for the directory.

A harness that offers neither route needs a hook of its own before handoff can be
in-place rather than by selection.
