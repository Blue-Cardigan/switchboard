// Gemini CLI, as a harness switchboard can move a conversation in and out of.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  chatsDirFor, listSessions, readSession, writeSession, forkSession, sessionIdOf,
} from '../geminiSession.mjs';
import { trimEvents } from '../codexRollout.mjs';
import { eventsToEntries, buildPreamble } from '../claudeTranscript.mjs';

const FROM = { name: 'Gemini CLI', unit: 'session' };

/** Tool calls Gemini records on a turn, as the activity lines a preamble shows. */
function activityOf(message) {
  return (message.toolCalls || []).map((call) => {
    const name = call.displayName || call.name || 'tool';
    const target = call.args?.file_path || call.args?.path || call.args?.command || '';
    return `- ${name}${target ? `: ${String(target).slice(0, 160)}` : ''}`;
  });
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).map((part) => part.text || '').join('').trim();
}

const EDITING_TOOLS = /^(write_file|replace|edit)$/;

export default {
  id: 'gemini',
  label: 'Gemini CLI',
  bin: 'gemini',

  // Gemini resumes by session id and rebuilds model history from the file it
  // resumes, so everything switchboard needs is on disk. Hooks exist but use
  // Claude Code's vocabulary rather than being wired here yet.
  capabilities: {
    read: true, write: true, resume: true, fork: true, headless: true, hooks: false,
  },

  resumeArgv(sessionId) {
    return ['gemini', '--resume', sessionId];
  },

  /**
   * Gemini exports no session id to the commands it runs, so the newest
   * conversation in this directory is the best available answer — and it is
   * only offered when Gemini is the process we are running inside.
   */
  live(cwd) {
    if (!this.hostEnv()) return null;
    const [newest] = listSessions(cwd, { limit: 1 });
    return newest && { id: newest.id, source: newest.source, cwd, via: 'newest session in this directory' };
  },

  list({ cwd = null, limit = 20 } = {}) {
    return cwd ? listSessions(cwd, { limit }).reverse() : [];
  },

  /** Turns of a Gemini session, in the shape every adapter passes around. */
  read(session, { full = false, budget } = {}) {
    const found = readSession(session.source || session.file);
    const messages = found?.messages || [];

    const counts = { user: 0, assistant: 0, commands: 0, fileChanges: 0 };
    const events = [];
    for (const message of messages) {
      if (message.type === 'user') {
        const text = textOf(message.displayContent || message.content);
        if (!text) continue;
        counts.user += 1;
        events.push({ role: 'user', text });
      } else if (message.type === 'gemini') {
        const text = textOf(message.content);
        if (text) { counts.assistant += 1; events.push({ role: 'assistant', text }); }
        for (const call of message.toolCalls || []) {
          counts.commands += 1;
          if (EDITING_TOOLS.test(call.name || '')) counts.fileChanges += 1;
        }
        for (const line of activityOf(message)) events.push({ kind: 'activity', text: line });
      }
    }

    const fitted = full ? { events, trimmed: false } : trimEvents(events, { maxChars: budget });
    const meta = {
      sessionId: found?.sessionId || null,
      cwd: session.cwd,
      startedAt: found?.startTime || null,
      model: null,
    };
    return {
      entries: eventsToEntries(fitted.events, { label: 'Gemini' }),
      meta,
      counts,
      trimmed: fitted.trimmed,
      preamble: buildPreamble(meta, counts, fitted.trimmed, FROM),
    };
  },

  /** A resumable Gemini session, built from turns taken anywhere. */
  write({ entries, cwd, preamble }) {
    const written = writeSession({ cwd, entries, preamble });
    return { id: written.sessionId, source: written.file, cwd, rows: written.rows };
  },

  /** Duplicate a conversation in place — no conversion, so nothing is lost. */
  fork({ source, cwd, model = null }) {
    const forked = forkSession({ source, cwd, model });
    return { id: forked.sessionId, source: forked.file, cwd, rows: forked.rows };
  },

  store(cwd) {
    const dir = chatsDirFor(cwd);
    return dir && fs.existsSync(dir) ? dir : null;
  },

  /** Is this process running inside a Gemini CLI session? */
  hostEnv() {
    return findGeminiAncestor() !== null;
  },

  sessionIdOf(source) {
    return sessionIdOf(source);
  },
};

function ps(field, pid) {
  try {
    return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Walk up the process tree looking for the Gemini CLI. */
function findGeminiAncestor(startPid = process.pid, maxDepth = 12) {
  let pid = startPid;
  for (let i = 0; i < maxDepth; i += 1) {
    const parent = ps('ppid', pid);
    if (!parent || parent === '0' || parent === '1') return null;
    if (/(^|\/)gemini$/.test(ps('comm', parent))) return Number(parent);
    pid = Number(parent);
  }
  return null;
}
