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
//
// `harness` is the agent the state belongs to — routing runs in both directions
// now, and a Codex session and a Claude session in the same directory must not
// read each other's mode. 'claude' keeps the original unsuffixed filename so
// existing state files are not orphaned.
export function keyFor(cwd, harness = 'claude') {
  const hash = crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return harness === 'claude' ? hash : `${hash}-${harness}`;
}

export function statePath(cwd, harness = 'claude') {
  return path.join(STATE_DIR, `${keyFor(cwd, harness)}.json`);
}

export const DEFAULTS = {
  mode: 'claude',       // the agent that answers; equal to the harness = not routed
  sessionId: null,      // null = unclaimed; the next prompt in this cwd adopts it
  cwd: null,
  profile: null,        // codex only
  model: null,
  effort: null,         // codex only
  sandbox: null,        // codex only
  permissionMode: null, // claude only
  relay: 'verbatim',    // verbatim | quiet
  seed: true,
  threadId: null,
  // How much of the source conversation the other agent has already been shown.
  // Claude side: lines of the Claude transcript. Codex side: bytes of the
  // rollout, which is append-only, so a byte offset makes each turn O(delta).
  transcriptCursor: 0,
  turns: 0,
  lastError: null,
  updatedAt: null,
};

export function load(cwd, harness = 'claude') {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(cwd, harness), 'utf8'));
    return { ...DEFAULTS, mode: harness, ...raw };
  } catch {
    return { ...DEFAULTS, mode: harness, cwd: path.resolve(cwd) };
  }
}

export function exists(cwd, harness = 'claude') {
  try { return fs.statSync(statePath(cwd, harness)).isFile(); } catch { return false; }
}

export function save(cwd, state, harness = 'claude') {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...state, cwd: path.resolve(cwd), updatedAt: new Date().toISOString() };
  const tmp = `${statePath(cwd, harness)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, statePath(cwd, harness));
  return next;
}

export function resetThread(state) {
  return { ...state, threadId: null, transcriptCursor: 0, turns: 0, lastError: null };
}
