#!/usr/bin/env node
// Hand the conversation running here to any registered harness, and open it
// beside this one.
//
// The cc/cx pair still owns the Claude↔Codex crossing, where it can close the
// harness it came from and give the same terminal back as the other one. This
// is the general path: it works for every pair, including the ones that have
// no way to take a terminal over, by opening the new session alongside.
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { get, host, ids } from './lib/harness/index.mjs';
import { desktopResumeCommand, openAlongside, openDesktop, resumeCommand } from './lib/launch.mjs';
import { rememberSurface, sourceSurface } from './lib/surface.mjs';
import { wrapperActive } from './lib/agentContext.mjs';
import { claudeProcess } from './lib/claudeSession.mjs';
import { resolveCodexTty } from './lib/currentSession.mjs';

const PENDING = fileURLToPath(new URL('./pending.mjs', import.meta.url));

export function canReplaceInPlace(source, target, proc, wrapped) {
  if (!wrapped || !proc?.pid || !proc.tty) return false;
  if (!((source === 'claude' && target === 'codex') ||
        (source === 'codex' && target === 'claude'))) return false;
  return source !== 'codex' || !proc.via?.startsWith('Codex client with the latest input');
}

function inPlaceSource(source, file) {
  if (source === 'claude') {
    const proc = claudeProcess();
    return proc?.tty ? proc : null;
  }
  if (source === 'codex') {
    const proc = resolveCodexTty(file);
    return proc;
  }
  return null;
}

function replaceInPlace(source, file, target, written, cwd) {
  const proc = inPlaceSource(source, file);
  // Input recency is only a guess when several Codex clients share a daemon.
  // Never close a client on that basis.
  if (!canReplaceInPlace(source, target, proc, wrapperActive())) return false;
  try {
    execFileSync(process.execPath, [PENDING, 'stage', proc.tty, target, written, cwd]);
    // Let the hook return before stopping its parent. The wrapper claims the
    // staged transcript when the original CLI releases this terminal.
    const child = spawn('sh', ['-c', 'sleep 0.8; kill -TERM "$1" 2>/dev/null', 'sh', String(proc.pid)], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
    rememberSurface(target, written, 'cli');
    return true;
  } catch {
    return false;
  }
}

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (['--to', '--from', '--cwd', '--source', '--prompt'].includes(arg)) { flags[arg.slice(2)] = argv[++i]; continue; }
    if (arg.startsWith('--')) { flags[arg.slice(2)] = true; continue; }
    rest.push(arg);
  }
  return { flags, rest };
}

async function main() {
  const { flags, rest } = parse(process.argv.slice(2));
  const targetId = flags.to || rest[0];
  if (!targetId) {
    throw new Error(`Name a harness to hand this to: ${ids().join(', ')}.`);
  }

  const target = get(String(targetId));
  const source = flags.from ? get(String(flags.from)) : host();
  if (!source) {
    throw new Error('Not running inside a harness, so there is no conversation to hand over.');
  }
  if (source.id === target.id) {
    throw new Error(`Already in ${target.label}. To duplicate this conversation instead: sb fork.`);
  }
  if (!source.capabilities.read) throw new Error(`${source.label} conversations cannot be read out.`);
  if (!target.capabilities.write) throw new Error(`${target.label} cannot be handed a conversation.`);

  const cwd = flags.cwd ? path.resolve(String(flags.cwd)) : process.cwd();
  // A hook already knows the exact file; guessing from the directory could pick
  // a neighbouring session.
  const live = flags.source
    ? { id: source.sessionIdOf?.(flags.source) ?? null, source: String(flags.source), cwd, via: 'named file' }
    : source.live(cwd);
  if (!live) throw new Error(`No ${source.label} conversation found for ${cwd}.`);

  process.stderr.write(`switchboard → ${target.id} (reading this ${source.label} conversation, ${live.via})…\n`);
  const read = await source.read(live, { full: Boolean(flags.full) });
  if (!read.entries.length) throw new Error(`No conversation recovered from ${live.source}.`);

  // Codex imports a Claude transcript directly, so handing it the file we are
  // already reading skips a synthesised copy of what it is about to parse.
  const written = await target.write({
    entries: read.entries,
    cwd,
    preamble: read.preamble,
    transcript: source.id === 'claude' ? live.source : null,
  });

  const from = live.id ? `${source.id} ${live.id.slice(0, 8)}` : `this ${source.label} conversation`;
  // A harness switchboard cannot write a session file for gets the conversation
  // as its opening prompt instead, and mints its own id when it starts.
  const into = written.pending ? `${target.id} (new conversation)` : `${target.id} ${written.id.slice(0, 8)}`;
  const line = `${from} → ${into} · ` +
    `${read.counts.user} prompt(s), ${read.counts.commands} command(s)${read.trimmed ? ', trimmed' : ''}` +
    `${written.reused ? ' (already imported)' : ''}`;

  // A harness that is not installed still gets a staged handoff — the command
  // is the same one, and it works the moment the binary is there.
  const hint = written.hint ? `\n  ${written.hint}` : '';
  const sameSurface = !flags.cli && ['claude', 'codex'].includes(source.id) &&
    ['claude', 'codex'].includes(target.id) &&
    sourceSurface(source.id, live.id, live.source) === 'desktop';
  const desktopCommand = (flags.app || sameSurface) && !flags.prompt && !written.pending
    ? desktopResumeCommand(written.id, cwd, target.id) : null;

  if (flags.print) {
    console.log(`${line}\n  ${desktopCommand || resumeCommand(written.id, cwd, target.id, flags.prompt || null)}${hint}`);
    return;
  }

  if (written.hint) {
    // Opening a pane on a missing command just flashes an error and closes it.
    console.log(`${line}\n  ${written.hint}\n  then: ${resumeCommand(written.id, cwd, target.id, flags.prompt || null)}`);
    return;
  }

  if (desktopCommand && openDesktop(written.id, cwd, target.id)) {
    rememberSurface(target.id, written.id, 'desktop');
    console.log(`${line}\n  opened ${target.id === 'codex' ? 'ChatGPT' : 'Claude'} desktop — ${source.label} is still running here.`);
    return;
  }
  if (flags.replace && !flags.prompt && !desktopCommand && !written.pending &&
      replaceInPlace(source.id, live.source, target.id, written.id, cwd)) {
    console.log(`${line}\n  replacing this CLI session in the same terminal.`);
    return;
  }
  const how = openAlongside(written.id, cwd, target.id, flags.prompt || null);
  if (how) rememberSurface(target.id, written.id, 'cli');
  if (how) console.log(`${line}\n  ${how} — ${source.label} is still running here.`);
  else console.log(`${line}\n  nothing here can open a pane; run this yourself:\n  ${resumeCommand(written.id, cwd, target.id, flags.prompt || null)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
