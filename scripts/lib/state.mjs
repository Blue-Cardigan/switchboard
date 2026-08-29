import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.join(os.homedir(), '.claude', 'switchboard');
const STATE_DIR = path.join(ROOT, 'state');
export const LOG_DIR = path.join(ROOT, 'logs');

// State is keyed by working directory, not session id: the slash command that
// flips the mode has no way to learn its own session id, but it does share a cwd
// with the hook that later claims the state.
export function keyFor(cwd) {
  return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

export function statePath(cwd) {
  return path.join(STATE_DIR, `${keyFor(cwd)}.json`);
}

export const DEFAULTS = {
  mode: 'claude',
  sessionId: null,      // null = unclaimed; the next prompt in this cwd adopts it
  cwd: null,
  profile: null,
  model: null,
  effort: null,
  sandbox: null,
  relay: 'verbatim',    // verbatim | quiet
  seed: true,
  threadId: null,
  transcriptCursor: 0,  // lines of the Claude transcript already handed to Codex
  turns: 0,
  lastError: null,
  updatedAt: null,
};

export function load(cwd) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(cwd), 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS, cwd: path.resolve(cwd) };
  }
}

export function exists(cwd) {
  try { return fs.statSync(statePath(cwd)).isFile(); } catch { return false; }
}

export function save(cwd, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...state, cwd: path.resolve(cwd), updatedAt: new Date().toISOString() };
  const tmp = `${statePath(cwd)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, statePath(cwd));
  return next;
}

export function resetThread(state) {
  return { ...state, threadId: null, transcriptCursor: 0, turns: 0, lastError: null };
}
