// Codex, as a harness switchboard can move a conversation in and out of.
import path from 'node:path';
import { listSessions, readRollout, trimEvents } from '../codexRollout.mjs';
import { detectCurrentSession } from '../currentSession.mjs';
import { eventsToEntries, buildPreamble, writeTranscript } from '../claudeTranscript.mjs';
import { importClaudeSession } from '../toCodex.mjs';

export default {
  id: 'codex',
  label: 'Codex',
  bin: 'codex',

  // Codex writes conversations only through its own importer, which reads a
  // Claude Code transcript — so `write` here is a round trip, and a fork would
  // be too. Flagged rather than hidden, so callers can offer something honest.
  capabilities: {
    read: true, write: true, resume: true, fork: false, headless: true, hooks: true,
  },

  resumeArgv(threadId) {
    return ['codex', 'resume', threadId];
  },

  live(cwd) {
    const found = detectCurrentSession({ cwd });
    return found && { id: found.sessionId, source: found.file, cwd: found.cwd || cwd, via: found.via };
  },

  list({ cwd = null, limit = 20 } = {}) {
    return listSessions({ cwd, limit });
  },

  /** Turns of a Codex thread, in the shape every adapter passes around. */
  async read(session, { full = false, budget } = {}) {
    const { meta, events, counts, truncated } = await readRollout(session.source || session.file);
    const fitted = full ? { events, trimmed: false } : trimEvents(events, { maxChars: budget });
    const entries = eventsToEntries(fitted.events);
    return {
      entries,
      meta,
      counts,
      trimmed: truncated || fitted.trimmed,
      preamble: buildPreamble({ ...meta, cwd: meta.cwd || session.cwd }, counts, truncated || fitted.trimmed),
    };
  },

  /**
   * Codex's importer only reads Claude transcripts, and only from inside
   * ~/.claude/projects — given anything else it silently imports its own
   * default discovery set instead. So staging one there is not a shortcut.
   */
  async write({ entries, cwd, preamble, transcript = null }) {
    const source = transcript || writeTranscript({ cwd, entries, preamble }).file;
    const { threadId, reused } = await importClaudeSession(source, cwd);
    return { id: threadId, source, cwd, reused };
  },

  hostEnv() {
    return Boolean(process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID);
  },

  sessionIdOf(source) {
    return (/rollout-.*?-([0-9a-f]{8}-[0-9a-f-]+)\.jsonl$/.exec(path.basename(source || '')) || [])[1] || null;
  },
};
