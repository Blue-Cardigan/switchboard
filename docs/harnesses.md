# Adding a harness

Switchboard used to branch on "Codex or Claude Code?" at every call site. It now asks a
registry, so a third harness is a file in `scripts/lib/harness/` rather than an edit
everywhere. Three are registered: `claude`, `codex`, `gemini`. `sb list` prints them
with what each one can do.

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
- **Gemini CLI** exports neither either, and has no hook installed yet, so `live()` only
  answers when Gemini is an ancestor of the running process and it answers with the
  newest session in the directory. Good enough to hand a conversation out of; not yet
  exact when two Gemini sessions share a directory.

A harness that offers neither route needs a hook of its own before handoff can be
in-place rather than by selection.

## Gemini CLI specifics

Worth knowing before you touch `scripts/lib/geminiSession.mjs`, because none of it is
documented and all of it was read out of the installed bundle:

- A session is JSONL at `~/.gemini/tmp/<slug>/chats/session-<timestamp>-<8 chars>.jsonl`.
  First line is metadata (`sessionId`, `projectHash`, `startTime`, `lastUpdated`,
  `kind`); the rest are messages (`id`, `timestamp`, `type: user|gemini`, `content`),
  plus `{"$set": …}` metadata updates and `{"$rewindTo": id}` truncations.
- `<slug>` is **not** a hash. Gemini keeps `~/.gemini/projects.json` mapping the
  normalised project path to a slugified basename, and marks ownership with a
  `.project_root` file under both `~/.gemini/tmp/<slug>/` and `~/.gemini/history/<slug>/`.
  Switchboard claims a slug the same way, so Gemini adopts it rather than allocating a
  second one for the same directory.
- The registry key keeps the path's original case on macOS — only win32 is case-folded.
  Gemini has a second `normalizePath` elsewhere in its bundle that *does* fold on darwin;
  copy that one and Gemini stops recognising its own key, then quietly allocates a
  duplicate slug (`proj-1`) next to yours, and every handed-off session goes missing.
- `--resume` takes `latest`, a 1-based index, **or a full session UUID** — which is what
  makes an id-addressed handoff possible at all.
- Rebuilding model history drops any user turn whose trimmed text starts with `/` or `?`
  (its command prefixes), so imported turns that open with one are quoted.
- `kind: "main"` matters: sessions recorded as `subagent` are hidden from the picker.

`SWITCHBOARD_GEMINI_HOME` overrides `~/.gemini` so a test can write somewhere
disposable. Gemini itself has no such override — it always reads the home directory.
