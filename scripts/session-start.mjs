#!/usr/bin/env node
// Claude Code does not export its session id the way Codex exports CODEX_THREAD_ID,
// and it does not hold its transcript open, so record the mapping at session start.
// Must fail open: this hook runs on every session in every project.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './lib/state.mjs';

function ps(field, pid) {
  try { return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

function claudeTty() {
  let pid = process.pid;
  for (let i = 0; i < 12; i += 1) {
    const parent = ps('ppid', pid);
    if (!parent || parent === '0' || parent === '1') return null;
    if (/claude/.test(ps('comm', parent))) {
      const tty = ps('tty', parent);
      return tty && tty !== '??' ? tty.replace(/^\/dev\//, '') : null;
    }
    pid = Number(parent);
  }
  return null;
}

try {
  const event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const tty = claudeTty();
  if (tty && event.session_id) {
    const dir = path.join(ROOT, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${tty}.json`), JSON.stringify({
      sessionId: event.session_id,
      transcriptPath: event.transcript_path || null,
      cwd: event.cwd || process.cwd(),
      at: Date.now(),
    }));
  }
} catch { /* never block a session start */ }
