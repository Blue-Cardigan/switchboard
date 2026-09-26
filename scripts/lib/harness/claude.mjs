// Claude Code, as a harness switchboard can move a conversation in and out of.
import fs from 'node:fs';
import path from 'node:path';
import { liveSession, forkTranscript } from '../claudeSession.mjs';
import { writeTranscript, projectDirFor, buildPreamble, isPristineAuthored } from '../claudeTranscript.mjs';
import { readTurnsSince } from '../transcript.mjs';

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

  list({ cwd = process.cwd(), limit = 20 } = {}) {
    const dir = projectDirFor(cwd);
    let names;
    try { names = fs.readdirSync(dir).filter((name) => /^[0-9a-f-]{36}\.jsonl$/i.test(name) && !isPristineAuthored(path.join(dir, name))); }
    catch { return []; }
    return names.map((name) => {
      const source = path.join(dir, name);
      return { id: name.slice(0, -6), source, cwd, mtime: fs.statSync(source).mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  },

  /** Turns of a Claude conversation, in the shape every adapter passes around. */
  read(session, { full = false, budget = 120000 } = {}) {
    const { turns } = readTurnsSince(session.source, 0);
    const counts = {
      user: turns.filter((t) => t.role === 'user').length,
      assistant: turns.filter((t) => t.role === 'assistant').length,
      commands: turns.filter((t) => /\[used \w+\]/.test(t.text)).length,
      fileChanges: turns.filter((t) => /\[used (Edit|Write|NotebookEdit)\]/.test(t.text)).length,
    };

    // Oldest turns go first when it will not fit: the tail is what the next
    // harness needs to carry on, and the opening is already in the preamble.
    let kept = turns;
    let trimmed = false;
    if (!full) {
      let total = turns.reduce((n, t) => n + t.text.length, 0);
      while (total > budget && kept.length > 4) {
        total -= kept[0].text.length;
        kept = kept.slice(1);
        trimmed = true;
      }
    }

    const meta = { sessionId: this.sessionIdOf(session.source), cwd: session.cwd, startedAt: null, model: null };
    const entries = kept.map((t) => ({ role: t.role === 'user' ? 'user' : 'assistant', text: t.text }));
    return {
      entries,
      meta,
      counts,
      trimmed,
      preamble: buildPreamble(meta, counts, trimmed, { name: 'Claude Code', unit: 'session' }),
    };
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
