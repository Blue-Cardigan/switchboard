import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { listSessions } from './codexRollout.mjs';

function ps(field, pid) {
  try {
    return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Walk up the process tree looking for the codex TUI that spawned this command. */
export function findCodexAncestor(startPid = process.pid, maxDepth = 12) {
  let pid = startPid;
  for (let i = 0; i < maxDepth; i += 1) {
    const parent = ps('ppid', pid);
    if (!parent || parent === '0' || parent === '1') return null;
    const comm = ps('comm', parent);
    if (/(^|\/)codex$/.test(comm) || /codex-code-mode-host|codex-exec/.test(comm)) return Number(parent);
    pid = Number(parent);
  }
  return null;
}

/** Rollout files a process currently holds open, newest first. */
export function openRollouts(pid) {
  let out = '';
  try {
    out = execFileSync('lsof', ['-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    out = err.stdout ? String(err.stdout) : '';
  }
  const files = [...new Set(out.match(/\S*\/\.codex\/sessions\/\S*\.jsonl/g) || [])];
  return files
    .map((file) => {
      try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .map((r) => r.file);
}

function rolloutIdOf(file) {
  return (/rollout-.*?-([0-9a-f]{8}-[0-9a-f-]+)\.jsonl$/.exec(path.basename(file)) || [])[1] || null;
}

/**
 * Identify the Codex session this command is running inside.
 * Three strategies, most reliable first; `via` says which one answered.
 */
export function detectCurrentSession({ cwd = process.cwd() } = {}) {
  const sessions = listSessions({ limit: 200 });

  // 1. Codex exports the ids into the command environment.
  const envId = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
  if (envId) {
    const match = sessions.find((s) => s.sessionId === envId || s.threadId === envId);
    if (match) return { ...match, via: 'CODEX_THREAD_ID' };
  }

  // 2. The codex process holding this shell also holds its rollout open.
  const pid = findCodexAncestor();
  if (pid) {
    const open = openRollouts(pid);
    if (open.length) {
      const file = open[0];
      const match = sessions.find((s) => s.file === file) || {
        file,
        sessionId: rolloutIdOf(file),
        cwd: null,
        mtime: fs.statSync(file).mtimeMs,
        bytes: fs.statSync(file).size,
      };
      return { ...match, via: `lsof pid ${pid}` };
    }
  }

  // 3. Most recently written session started in this directory.
  const here = sessions.find((s) => s.cwd === path.resolve(cwd));
  if (here) return { ...here, via: 'newest session in this directory' };

  return null;
}

/**
 * The rollout a known session id is writing to. Codex's hook payload names the
 * session but not its file, and the router needs the file to read the turns it
 * has not forwarded yet.
 */
export function rolloutForSession(sessionId, cwd = process.cwd()) {
  if (sessionId) {
    const match = listSessions({ limit: 200 })
      .find((s) => s.sessionId === sessionId || s.threadId === sessionId);
    if (match) return match.file;
  }
  return detectCurrentSession({ cwd })?.file ?? null;
}

function ttyOf(pid) {
  const t = ps('tty', pid).trim();
  return t && t !== '??' ? t.replace(/^\/dev\//, '') : null;
}

/**
 * The terminal the Codex TUI owns. When Codex exits, the shell that launched it
 * regains this tty — which is how an in-place handoff finds its way home.
 */
export function resolveCodexTty(sessionFile = null) {
  const ancestor = findCodexAncestor();
  if (ancestor) {
    const tty = ttyOf(ancestor);
    if (tty) return { tty, pid: ancestor, via: `ancestor pid ${ancestor}` };
  }
  if (sessionFile) {
    let pids = '';
    try {
      pids = execFileSync('pgrep', ['-x', 'codex'], { encoding: 'utf8' });
    } catch { pids = ''; }
    for (const raw of pids.split('\n').map((p) => p.trim()).filter(Boolean)) {
      if (!openRollouts(raw).includes(sessionFile)) continue;
      const tty = ttyOf(raw);
      if (tty) return { tty, pid: Number(raw), via: `pid ${raw} holds this rollout` };
    }
  }
  return null;
}
