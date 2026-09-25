// Claude Code, as a harness switchboard can move a conversation in and out of.
import fs from 'node:fs';
import path from 'node:path';
import { liveSession, forkTranscript } from '../claudeSession.mjs';
import { writeTranscript, projectDirFor } from '../claudeTranscript.mjs';

export default {
  id: 'claude',
  label: 'Claude Code',
  bin: 'claude',

  // What this harness can do, so callers ask instead of assuming. `fork` means
  // a conversation can be duplicated without a round trip through another one.
  capabilities: {
    read: true, write: true, resume: true, fork: true, headless: true, hooks: true,
  },

  /** How to reopen a conversation. The shell claim path execs this verbatim. */
  resumeArgv(sessionId) {
    return ['claude', '--resume', sessionId];
  },

  /** The conversation running in this terminal, if it is one of ours. */
  live(cwd) {
    const found = liveSession(cwd);
    return found && { id: null, source: found.source, cwd: found.cwd || cwd, via: found.via };
  },

  /** A resumable Claude conversation, built from turns taken anywhere. */
  write({ entries, cwd, preamble }) {
    const written = writeTranscript({ cwd, entries, preamble });
    return { id: written.sessionId, source: written.file, cwd, rows: written.rows };
  },

  /** Duplicate a conversation in place — no conversion, so nothing is lost. */
  fork({ source, cwd, model = null }) {
    const forked = forkTranscript({ source, cwd, model });
    return { id: forked.sessionId, source: forked.file, cwd, rows: forked.rows };
  },

  /** Where this harness keeps the conversations for a directory. */
  store(cwd) {
    const dir = projectDirFor(cwd);
    return fs.existsSync(dir) ? dir : null;
  },

  /** Is this process running inside a Claude Code session? */
  hostEnv() {
    // Claude Code exports no session id, but it does mark the environment.
    return Boolean(process.env.CLAUDE_CODE_ENTRYPOINT || /^claude-code/.test(process.env.AI_AGENT || ''));
  },

  sessionIdOf(source) {
    return path.basename(source).replace(/\.jsonl$/, '');
  },
};
