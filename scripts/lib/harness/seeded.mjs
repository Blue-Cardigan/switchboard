// A harness switchboard can hand a conversation to, but cannot read.
//
// The adapters with a file format behind them (Claude, Codex, Gemini) are
// hand-written because their stores are stable and documented. Most of the
// field is neither: opencode, goose, crush, aider and the rest keep sessions in
// their own databases, on their own schedules, and a format guessed today rots
// without warning. What every one of them does have is a way to start on a
// prompt — so that is the seam switchboard uses, and the whole adapter reduces
// to "which flag, and is it installed?".
//
// The trade is explicit: the conversation arrives as one opening message rather
// than as turns the model can see itself having taken, and the harness owns the
// session from then on. That is enough to keep working; it is not a transplant.
import { isSeed, seedScript, stageSeed, writeLauncher } from '../seed.mjs';
import { findAncestor, onPath } from '../proc.mjs';

export function seededHarness(spec) {
  const pattern = new RegExp(`(^|/)${spec.bin}$`);

  return {
    id: spec.id,
    label: spec.label,
    bin: spec.bin,
    install: spec.install,
    docs: spec.docs,
    note: spec.note || null,
    // Said out loud in `sb list`: these flags come from each project's own
    // documentation, and switchboard has not run them against an installed
    // binary. `sb list` says which are installed here.
    unverified: spec.verified ? null : `flags from ${spec.docs}`,

    capabilities: {
      read: false,
      write: true,
      resume: Boolean(spec.resumeArgv),
      fork: false,
      headless: spec.headless !== false,
      hooks: false,
    },

    /** Seeds open through their launcher; real ids go to the harness's own flag. */
    resumeArgv(sessionId) {
      if (isSeed(sessionId)) return ['sh', seedScript(sessionId)];
      if (spec.resumeArgv) return spec.resumeArgv(sessionId);
      throw new Error(`${spec.label} has no way to reopen a session by id.`);
    },

    /** Nothing readable on disk, so there is no conversation to point at. */
    live() {
      return null;
    },

    list() {
      return [];
    },

    read() {
      throw new Error(
        `${spec.label} conversations cannot be read out — switchboard only knows how to hand one to ${spec.bin}.`,
      );
    },

    /** Stage the conversation, and the one command that opens it. */
    write({ entries, cwd, preamble }) {
      const seed = stageSeed({ cwd, entries, preamble });
      writeLauncher(seed.id, spec.launch({ seed: seed.file, id: seed.id, cwd }));
      return {
        id: seed.id,
        source: seed.file,
        cwd,
        rows: seed.entries,
        pending: true,
        hint: onPath(spec.bin) ? null : `${spec.bin} is not installed here — ${spec.install}`,
      };
    },

    store() {
      return null;
    },

    hostEnv() {
      return findAncestor(pattern) !== null;
    },

    sessionIdOf() {
      return null;
    },
  };
}
