#!/usr/bin/env node
// Hand the current Claude Code conversation to Codex, in place.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { ROOT } from './lib/state.mjs';
import { importClaudeSession } from './lib/toCodex.mjs';
import { wrapperActive } from './lib/agentContext.mjs';
import { projectDirFor } from './lib/claudeTranscript.mjs';

function ps(field, pid) {
  try { return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

/** The Claude Code process that owns this shell, and the terminal it holds. */
function claudeProcess() {
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
function newestTranscript(cwd) {
  const dir = projectDirFor(cwd);
  let best = null;
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
  for (const name of names) {
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!best || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs };
  }
  return best?.path ?? null;
}

function resolveSession(cwd, tty) {
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

async function main() {
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2)));
  const cwd = process.cwd();
  const proc = claudeProcess();
  const session = resolveSession(cwd, proc?.tty);
  if (!session) throw new Error(`No Claude transcript found for ${cwd}.`);

  process.stderr.write(`switchboard → codex (importing this conversation, ${session.via})…\n`);
  const { threadId, reused } = await importClaudeSession(session.source, session.cwd);
  const line = `claude ${path.basename(session.source).slice(0, 8)} → codex ${threadId.slice(0, 8)}${reused ? ' (already imported)' : ''}`;

  if (flags.has('print') || !proc?.tty) {
    console.log(`${line}\n  cd ${JSON.stringify(session.cwd)} && codex resume ${threadId}`);
    return;
  }

  execFileSync(process.execPath, [
    new URL('./pending.mjs', import.meta.url).pathname,
    'stage', proc.tty, 'codex', threadId, session.cwd,
  ]);
  console.log(`${line}\n  staged for ${proc.tty}.`);

  if (flags.has('quit') && proc.pid) {
    const child = spawn('sh', ['-c', `sleep 0.4; kill -TERM ${proc.pid} 2>/dev/null`], { detached: true, stdio: 'ignore' });
    child.unref();
    if (wrapperActive()) {
      console.log('\nClosing Claude Code now — this terminal will come back as Codex.');
    } else {
      console.log(
        '\nClosing Claude Code now. This terminal\'s shell started before the switchboard' +
        '\nwrapper was installed, so it cannot reopen Codex on its own.' +
        '\n\n  >>> type  cx  at the prompt to finish the handoff. <<<' +
        '\n\nTerminals opened from now on do it by themselves.',
      );
    }
  } else {
    console.log('\nExit Claude Code (Ctrl-D), then run  cx  at the prompt to finish.');
  }
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
