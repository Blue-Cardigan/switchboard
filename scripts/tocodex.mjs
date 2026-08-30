#!/usr/bin/env node
// Hand a Claude Code conversation to Codex — the one running in this terminal,
// or one from Claude desktop's local agent mode.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { ROOT } from './lib/state.mjs';
import { importClaudeSession } from './lib/toCodex.mjs';
import { wrapperActive } from './lib/agentContext.mjs';
import { projectDirFor } from './lib/claudeTranscript.mjs';
import { listDesktopSessions, materialiseDesktopSession, pickDesktopSession } from './lib/claudeDesktop.mjs';
import { openAlongside, resumeCommand } from './lib/launch.mjs';

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cwd' || arg === '--limit') { flags[arg.slice(2)] = argv[++i]; continue; }
    if (arg.startsWith('--')) { flags[arg.slice(2)] = true; continue; }
    rest.push(arg);
  }
  return { flags, rest };
}

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

function ago(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Pull a Claude desktop (local agent mode) conversation into Codex. */
async function fromDesktop(flags, selector) {
  const sessions = listDesktopSessions({
    limit: Number(flags.limit) || 20,
    includeArchived: Boolean(flags.archived),
  });
  if (!sessions.length) {
    throw new Error('No Claude desktop sessions found. Open one in Claude, then try again.');
  }

  if (selector === undefined) {
    console.log('Claude desktop sessions:\n');
    sessions.forEach((s, i) => {
      const size = `${Math.round(s.bytes / 1e3)}kB`;
      console.log(`${String(i + 1).padStart(3)}. ${ago(s.mtime).padStart(8)} ${size.padStart(7)}  ${s.title || s.sessionId}`);
    });
    console.log('\nHand one to Codex with its number, e.g.  cx --desktop 1');
    return;
  }

  const chosen = pickDesktopSession(sessions, selector);
  const cwd = flags.cwd ? path.resolve(String(flags.cwd)) : chosen.cwd;
  process.stderr.write(`switchboard → codex (importing "${chosen.title || chosen.sessionId}")…\n`);
  const local = materialiseDesktopSession(chosen, cwd);
  const { threadId, reused } = await importClaudeSession(local.path, cwd);
  const line = `desktop ${chosen.title || chosen.sessionId} → codex ${threadId.slice(0, 8)}${reused ? ' (already imported)' : ''}`;

  if (flags.print) {
    console.log(`${line}\n  ${resumeCommand(threadId, cwd, 'codex')}`);
    return;
  }
  const how = openAlongside(threadId, cwd, 'codex');
  if (how) console.log(`${line}\n  ${how}.`);
  else console.log(`${line}\n  run this to pick it up:\n  ${resumeCommand(threadId, cwd, 'codex')}`);
}

async function main() {
  const { flags, rest } = parse(process.argv.slice(2));

  if (flags.desktop) {
    await fromDesktop(flags, flags.desktop === true ? rest[0] : String(flags.desktop));
    return;
  }

  const cwd = process.cwd();
  const proc = claudeProcess();
  const session = resolveSession(cwd, proc?.tty);
  if (!session) throw new Error(`No Claude transcript found for ${cwd}.`);

  process.stderr.write(`switchboard → codex (importing this conversation, ${session.via})…\n`);
  const { threadId, reused } = await importClaudeSession(session.source, session.cwd);
  const line = `claude ${path.basename(session.source).slice(0, 8)} → codex ${threadId.slice(0, 8)}${reused ? ' (already imported)' : ''}`;

  if (flags.print || (!proc?.tty && !flags.alongside)) {
    console.log(`${line}\n  ${resumeCommand(threadId, session.cwd, 'codex')}`);
    return;
  }

  // Alongside: open Codex next to this session instead of taking its place, so
  // Claude Code keeps running and nothing needs to be claimed later.
  if (flags.alongside) {
    const how = openAlongside(threadId, session.cwd, 'codex');
    if (how) console.log(`${line}\n  ${how} — Claude Code is still running here.`);
    else console.log(`${line}\n  nothing here can open a pane; run this yourself:\n  ${resumeCommand(threadId, session.cwd, 'codex')}`);
    return;
  }

  execFileSync(process.execPath, [
    new URL('./pending.mjs', import.meta.url).pathname,
    'stage', proc.tty, 'codex', threadId, session.cwd,
  ]);
  console.log(`${line}\n  staged for ${proc.tty}.`);

  if (flags.quit && proc.pid) {
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
