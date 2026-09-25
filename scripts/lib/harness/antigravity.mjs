// Antigravity CLI (`agy`), Google's replacement for personal Gemini CLI access.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  conversationsDir, listSessions, readSession, seedsDir, sessionIdOf, stageSeed,
} from '../antigravitySession.mjs';
import { trimEvents } from '../codexRollout.mjs';
import { eventsToEntries, buildPreamble } from '../claudeTranscript.mjs';

const FROM = { name: 'Antigravity', unit: 'conversation' };
const EDITING_TOOLS = /(write|edit|replace|create)_file|apply_patch|str_replace/i;

function seedScript(id) {
  return path.join(seedsDir(), `${id}.sh`);
}

/** Seed ids belong to a conversation Antigravity has not started yet. */
function isSeed(id) {
  return Boolean(id) && fs.existsSync(seedScript(id));
}

export default {
  id: 'antigravity',
  label: 'Antigravity',
  bin: 'agy',

  // Read is real: conversations are on disk and switchboard parses them.
  // Write is not a file switchboard authors — Antigravity keeps conversations
  // as protobuf in SQLite and self-updates in the background, so a hand-written
  // one would rot without warning. Handing it a conversation opens `agy` with
  // the transcript as its first prompt instead, which is a supported entry
  // point and survives version changes. Forking is the same move, in place.
  capabilities: {
    read: true, write: true, resume: true, fork: true, headless: true, hooks: false,
  },

  /** How a conversation gets opened: by id if it exists, by seed if it does not. */
  resumeArgv(sessionId) {
    return isSeed(sessionId)
      ? ['sh', seedScript(sessionId)]
      : ['agy', '--conversation', sessionId];
  },

  /**
   * Antigravity records the workspace against each conversation, so the live
   * one is an exact lookup rather than a guess — but only offered while `agy`
   * is the process we are running inside, since the newest conversation for a
   * directory is not necessarily the one in front of you.
   */
  live(cwd) {
    if (!this.hostEnv()) return null;
    const [newest] = listSessions(cwd, { limit: 1 });
    return newest && {
      id: newest.id, source: newest.source, cwd, via: 'newest conversation for this directory',
    };
  },

  list({ cwd = null, limit = 20 } = {}) {
    return cwd ? listSessions(cwd, { limit }).reverse() : [];
  },

  /** Turns of an Antigravity conversation, in the shape every adapter passes around. */
  read(session, { full = false, budget } = {}) {
    const found = readSession(session.source || session.file || session.id);
    const counts = { user: 0, assistant: 0, commands: 0, fileChanges: 0 };
    const events = [];

    for (const message of found.messages) {
      if (message.type === 'user') {
        counts.user += 1;
        events.push({ role: 'user', text: message.text });
      } else if (message.type === 'agent') {
        counts.assistant += 1;
        events.push({ role: 'assistant', text: message.text });
      } else if (message.type === 'tool') {
        counts.commands += 1;
        if (EDITING_TOOLS.test(message.name || '')) counts.fileChanges += 1;
        events.push({ kind: 'activity', text: message.text });
      }
    }

    const fitted = full ? { events, trimmed: false } : trimEvents(events, { maxChars: budget });
    const meta = { sessionId: found.id, cwd: session.cwd, startedAt: null, model: null };
    return {
      entries: eventsToEntries(fitted.events, { label: 'Antigravity' }),
      meta,
      counts,
      trimmed: fitted.trimmed,
      preamble: buildPreamble(meta, counts, fitted.trimmed, FROM),
    };
  },

  /**
   * Stage the conversation for Antigravity to open. What comes back is a seed,
   * not a conversation: `agy` mints the conversation id when it starts, and
   * from then on the conversation is its own, resumable with --conversation.
   */
  write({ entries, cwd, preamble }) {
    const seed = stageSeed({ cwd, entries, preamble });
    fs.writeFileSync(
      seedScript(seed.id),
      `#!/bin/sh\nexec agy "--prompt-interactive=$(cat ${JSON.stringify(seed.file)})"\n`,
      { mode: 0o700 },
    );
    return { id: seed.id, source: seed.file, cwd, rows: seed.entries, pending: true };
  },

  /** A side chat that starts knowing what this one knows. */
  fork({ source, cwd, model = null }) {
    const read = this.read({ source, cwd });
    const written = this.write({ entries: read.entries, cwd, preamble: read.preamble });
    return { ...written, model };
  },

  store(cwd) {
    const dir = conversationsDir();
    return cwd && fs.existsSync(dir) ? dir : null;
  },

  /** Is this process running inside an Antigravity conversation? */
  hostEnv() {
    if (process.env.ANTIGRAVITY_CONVERSATION_ID) return true;
    return findAgyAncestor() !== null;
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

/** Walk up the process tree looking for the agy binary. */
function findAgyAncestor(startPid = process.pid, maxDepth = 12) {
  let pid = startPid;
  for (let i = 0; i < maxDepth; i += 1) {
    const parent = ps('ppid', pid);
    if (!parent || parent === '0' || parent === '1') return null;
    if (/(^|\/)agy$/.test(ps('comm', parent))) return Number(parent);
    pid = Number(parent);
  }
  return null;
}
