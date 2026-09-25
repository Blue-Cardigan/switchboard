#!/usr/bin/env node
// Hand a Claude Code conversation to Codex — the one running in this terminal,
// or one from Claude desktop's local agent mode.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { ROOT } from './lib/state.mjs';
import { importClaudeSession } from './lib/toCodex.mjs';
import { wrapperActive } from './lib/agentContext.mjs';
import { claudeProcess, resolveSession } from './lib/claudeSession.mjs';
import { projectDirFor } from './lib/claudeTranscript.mjs';
import { readTurnsSince, renderBriefing } from './lib/transcript.mjs';
import { listSessions } from './lib/codexRollout.mjs';
import { listDesktopSessions, materialiseDesktopSession, pickDesktopSession } from './lib/claudeDesktop.mjs';
import { openAlongside, resumeCommand } from './lib/launch.mjs';

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cwd' || arg === '--limit' || arg === '--session') { flags[arg.slice(2)] = argv[++i]; continue; }
    if (arg.startsWith('--')) { flags[arg.slice(2)] = true; continue; }
    rest.push(arg);
  }
  return { flags, rest };
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

/** Read this conversation's turns, or explain why there are none. */
function turnsOf(session) {
  const { turns } = readTurnsSince(session.source, 0);
  if (!turns.length) throw new Error(`No conversation recovered from ${session.source}.`);
  return turns;
}

/**
 * Print the conversation as text — the mirror of `cx2cc context`. For pasting
 * into a Codex session that is already running, when you want its context
 * without starting a new thread.
 */
function printContext(session) {
  const turns = turnsOf(session);
  console.log(`Claude Code conversation in ${session.cwd} — ${turns.length} turns, ${session.via}.`);
  for (const turn of turns) {
    console.log(`\n### ${turn.role === 'user' ? 'You (in Claude Code)' : 'Claude'}\n${turn.text}`);
  }
}

/**
 * Push the conversation into a Codex thread that is already running, rather than
 * opening a new one. `codex queue` appends to a live session's input queue, so
 * the transcript lands in the TUI the user is looking at.
 */
function queueToThread(session, selector) {
  let thread = typeof selector === 'string' ? selector : null;
  if (!thread) {
    const sessions = listSessions({ limit: 50 });
    const here = sessions.find((s) => s.cwd === path.resolve(session.cwd)) || sessions[0];
    if (!here) throw new Error('No Codex session to queue into. Pass one: cx --queue <thread-id|name>.');
    thread = here.threadId || here.sessionId;
  }

  const rendered = renderBriefing(turnsOf(session), '', { assistantLabel: 'Claude' });
  const message = [
    'Handing this over from Claude Code. Transcript of the conversation so far:',
    '',
    rendered,
    '',
    '--- end transcript ---',
    '',
    'Carry on from here.',
  ].join('\n');

  const bin = process.env.SWITCHBOARD_CODEX_BIN || 'codex';
  const run = spawnSync(bin, ['queue', '--thread', thread, '--message', message], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (run.error) throw new Error(`could not run ${bin}: ${run.error.message}`);
  if (run.status !== 0) {
    const detail = (run.stderr || run.stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
    throw new Error(`codex queue exited ${run.status}${detail ? `: ${detail}` : '.'}`);
  }
  console.log(
    `claude ${path.basename(session.source).slice(0, 8)} → queued into codex ${String(thread).slice(0, 8)}\n` +
    '  It arrives on that session\'s next turn; Claude Code keeps running here.',
  );
}

async function main() {
  const { flags, rest } = parse(process.argv.slice(2));

  if (flags.desktop) {
    await fromDesktop(flags, flags.desktop === true ? rest[0] : String(flags.desktop));
    return;
  }

  // Like `cc <thread>`, a positional identifier selects a saved conversation.
  // Keep --session as an alias for terminals that already use it.
  if (!flags.session && !flags.queue && rest.length) flags.session = rest.shift();
  if (rest.length && !flags.queue) throw new Error(`Unexpected argument: ${rest[0]}`);

  const cwd = flags.cwd ? path.resolve(String(flags.cwd)) : process.cwd();
  const proc = flags.session ? null : claudeProcess();
  let session;
  if (flags.session) {
    const id = String(flags.session);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`Expected a Claude session UUID after --session, got ${id}.`);
    }
    const source = path.join(projectDirFor(cwd), `${id}.jsonl`);
    if (!fs.existsSync(source)) throw new Error(`Claude transcript not found: ${source}`);
    session = { source, cwd, via: 'explicit session id' };
  } else {
    session = resolveSession(cwd, proc?.tty);
  }
  if (!session) throw new Error(`No Claude transcript found for ${cwd}.`);

  // Both of these leave Claude Code running and start no new Codex thread.
  if (flags.context) { printContext(session); return; }
  if (flags.queue) { queueToThread(session, flags.queue === true ? rest[0] : String(flags.queue)); return; }

  process.stderr.write(`switchboard → codex (importing this conversation, ${session.via})…\n`);
  const { threadId, reused, originalBytes, importedBytes } = await importClaudeSession(session.source, session.cwd);
  const compacted = importedBytes < originalBytes
    ? ` · ${Math.round(originalBytes / 1000)} kB → ${Math.round(importedBytes / 1000)} kB`
    : '';
  const line = `claude ${path.basename(session.source).slice(0, 8)} → codex ${threadId.slice(0, 8)}${reused ? ' (already imported)' : ''}${compacted}`;

  if (flags.print || (!proc?.tty && !flags.alongside)) {
    if (flags.session && !flags.print) {
      console.log(`${line}\n  opening Codex here…`);
      const child = spawn('codex', ['resume', threadId], { cwd: session.cwd, stdio: 'inherit' });
      process.exitCode = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => resolve(code ?? 1));
      });
      return;
    }
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
