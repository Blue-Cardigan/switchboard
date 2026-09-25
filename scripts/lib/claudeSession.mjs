// Finding — and duplicating — the Claude Code conversation running in this
// terminal. Claude Code exports no session id and does not hold its transcript
// open, so this walks the process tree to a tty and reads what the SessionStart
// hook recorded for it, falling back to the newest transcript for the directory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT } from './state.mjs';
import { isPristineAuthored, projectDirFor, recordAuthored } from './claudeTranscript.mjs';

function ps(field, pid) {
  try { return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

/** The Claude Code process that owns this shell, and the terminal it holds. */
export function claudeProcess() {
  let pid = process.pid;
  for (let i = 0; i < 12; i += 1) {
    const parent = ps('ppid', pid);
    if (!parent || parent === '0' || parent === '1') return null;
    if (/claude/.test(ps('comm', parent))) {
      const tty = ps('tty', parent);
      return { pid: Number(parent), tty: tty && tty !== '??' ? tty.replace(/^\/dev\//, '') : null };
    }
    pid = Number(parent);
  }
  return null;
}

/** Newest transcript written for this directory — the running session, in practice. */
export function newestTranscript(cwd) {
  const dir = projectDirFor(cwd);
  let best = null;
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
  for (const name of names) {
    const full = path.join(dir, name);
    // A transcript switchboard wrote for an import, which nobody has resumed, is
    // not this conversation. Handing one back would return Codex its own words.
    if (isPristineAuthored(full)) continue;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!best || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs };
  }
  return best?.path ?? null;
}

export function resolveSession(cwd, tty) {
  if (tty) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', `${tty}.json`), 'utf8'));
      if (rec.transcriptPath && fs.existsSync(rec.transcriptPath)) {
        return { source: rec.transcriptPath, cwd: rec.cwd || cwd, via: 'SessionStart hook' };
      }
    } catch { /* fall through */ }
  }
  const source = newestTranscript(cwd);
  if (source) return { source, cwd, via: 'newest transcript for this directory' };
  return null;
}

/** The conversation running here, however we can identify it. */
export function liveSession(cwd = process.cwd()) {
  const proc = claudeProcess();
  return resolveSession(cwd, proc?.tty);
}

/**
 * Copy a transcript to a new session id so both can run at once. Rows are copied
 * as they are, not rebuilt: that keeps tool calls, images and the model the
 * parent was using, so the fork is the same conversation rather than a summary
 * of it. `model` overrides the copy's model instead — a cheap second opinion on
 * expensive context.
 */
export function forkTranscript({ source, cwd, model = null }) {
  const sessionId = crypto.randomUUID();
  const dir = projectDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${sessionId}.jsonl`);

  let rows = 0;
  const out = [];
  for (const line of fs.readFileSync(source, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    // Both spellings appear in real transcripts, on different row types.
    if (row.sessionId) row.sessionId = sessionId;
    if (row.session_id) row.session_id = sessionId;
    if (row.cwd) row.cwd = path.resolve(cwd);
    if (model && row.type === 'assistant' && row.message) row.message.model = model;
    out.push(JSON.stringify(row));
    if (row.type === 'user' || row.type === 'assistant') rows += 1;
  }
  if (!rows) throw new Error(`Nothing to fork: ${path.basename(source)} has no conversation rows.`);

  fs.writeFileSync(target, `${out.join('\n')}\n`);
  recordAuthored(target);
  return { sessionId, file: target, rows };
}
