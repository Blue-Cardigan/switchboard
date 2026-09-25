#!/usr/bin/env node
// Convert a Codex session into a Claude Code conversation.
//   list                     index recent Codex sessions
//   prepare [selector]       write the transcript, print "<sessionId>\t<cwd>"
//   context [selector]       print the conversation for pasting into a live session
//   desktop [selector]       same, for a Claude desktop (local agent mode) session
// Selector: --last | --here | <index from list> | <session id prefix>
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { listSessions, readRollout, trimEvents } from './lib/codexRollout.mjs';
import { eventsToEntries, buildPreamble, writeTranscript } from './lib/claudeTranscript.mjs';
import { desktopRoot, listDesktopSessions, materialiseDesktopSession, pickDesktopSession } from './lib/claudeDesktop.mjs';
import { detectCurrentSession, findCodexAncestor, openRollouts, resolveCodexTty } from './lib/currentSession.mjs';
import { ROOT } from './lib/state.mjs';
import { currentAgent, wrapperActive } from './lib/agentContext.mjs';
import { openAlongside, openInTerminal, resumeCommand } from './lib/launch.mjs';

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') { flags.limit = Number(argv[++i]); continue; }
    // These take a value. Without this they would parse as booleans and their
    // value would fall through to `rest`, where it reads as a session selector.
    if (arg === '--cwd' || arg === '--budget') { flags[arg.slice(2)] = argv[++i]; continue; }
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

function pick(sessions, flags, rest, cwd) {
  // An explicit rollout path — what Codex's own /rollout command prints — is
  // authoritative, so it skips every heuristic.
  const first = rest[0];
  if (first && first.endsWith('.jsonl')) {
    const file = path.resolve(first.replace(/^~/, os.homedir()));
    if (!fs.existsSync(file)) throw new Error(`No rollout file at ${file}`);
    const known = sessions.find((s) => s.file === file);
    if (known) return known;
    const id = (/rollout-.*?-([0-9a-f]{8}-[0-9a-f-]+)\.jsonl$/.exec(path.basename(file)) || [])[1];
    return { file, sessionId: id || path.basename(file), cwd: null, via: 'rollout path' };
  }
  if (flags.here) {
    const here = sessions.find((s) => s.cwd === path.resolve(cwd));
    if (!here) throw new Error(`No Codex session recorded for ${path.resolve(cwd)}. Try "list".`);
    return here;
  }
  const selector = rest[0];
  if (!selector || flags.last) return sessions[0];
  if (/^\d+$/.test(selector)) {
    const chosen = sessions[Number(selector) - 1];
    if (!chosen) throw new Error(`No session ${selector}; "list" shows ${sessions.length}.`);
    return chosen;
  }
  const match = sessions.filter((s) => s.sessionId.startsWith(selector));
  if (match.length === 1) return match[0];
  if (match.length > 1) throw new Error(`"${selector}" matches ${match.length} sessions; use more characters.`);

  // Fall back to the thread name the ChatGPT desktop app shows.
  const needle = selector.toLowerCase();
  const named = sessions.filter((s) => (s.name || '').toLowerCase().includes(needle));
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new Error(`"${selector}" matches ${named.length} thread names; be more specific.`);
  throw new Error(`No Codex session id or thread name matches "${selector}".`);
}

async function convert(chosen, flags) {
  const { meta, events, counts, truncated } = await readRollout(chosen.file);
  const fitted = flags.full
    ? { events, trimmed: false }
    : trimEvents(events, { maxChars: flags.budget ? Number(flags.budget) : undefined });
  const entries = eventsToEntries(fitted.events);
  if (!entries.length) throw new Error(`Session ${chosen.sessionId.slice(0, 8)} has no recoverable conversation.`);
  const target = meta.cwd || chosen.cwd || process.cwd();
  const preamble = buildPreamble({ ...meta, cwd: target }, counts, truncated || fitted.trimmed);
  const written = writeTranscript({ cwd: target, entries, preamble });
  return { written, target, counts, trimmed: truncated || fitted.trimmed };
}

async function handoff(verb, flags, sessions, cwd, rest = []) {
  let targets;
  if (verb === 'handoff' && rest.length) {
    // An explicit rollout path or selector beats auto-detection.
    targets = [{ ...pick(sessions, flags, rest, cwd), via: 'given explicitly' }];
  } else if (verb === 'drain') {
    // Every live Codex TUI, resolved through the rollout each one holds open.
    const pids = String(execFileSync('pgrep', ['-x', 'codex'], { encoding: 'utf8' }) || '')
      .split('\n').map((p) => p.trim()).filter(Boolean);
    const seen = new Set();
    targets = [];
    for (const pid of pids) {
      const file = openRollouts(pid)[0];
      if (!file || seen.has(file)) continue;
      seen.add(file);
      const match = sessions.find((s) => s.file === file);
      if (match) targets.push({ ...match, via: `pid ${pid}` });
    }
    if (!targets.length) throw new Error('No live Codex sessions found (pgrep -x codex returned nothing usable).');
  } else {
    const current = detectCurrentSession({ cwd });
    if (!current) throw new Error('Could not work out which Codex session this is. Try "cx2cc list" and pass a number.');
    targets = [current];
  }

  const wrapperInstalled = fs.existsSync(path.join(ROOT, 'wrapper-installed'));
  // --alongside (--window is the old name) opens Claude next to Codex instead of
  // taking its terminal, so nothing gets staged and nothing gets closed.
  const alongside = Boolean(flags.alongside || flags.window);
  const wantsReplace = !alongside && (flags.replace || (wrapperInstalled && !flags.print));
  let staged = 0;
  let quitting = false;

  for (const target of targets) {
    const { written, target: dir, counts, trimmed } = await convert(target, flags);
    const line = `${target.sessionId.slice(0, 8)} (${target.via || 'selected'}) → claude ${written.sessionId.slice(0, 8)}` +
      ` · ${written.rows} turns, ${counts.commands} commands${trimmed ? ', trimmed' : ''}`;

    if (flags.print) {
      console.log(`${line}\n  ${resumeCommand(written.sessionId, dir)}`);
      continue;
    }

    if (wantsReplace) {
      const terminal = resolveCodexTty(target.file);
      if (terminal) {
        execFileSync(process.execPath, [
          new URL('./pending.mjs', import.meta.url).pathname,
          'stage', terminal.tty, 'claude', written.sessionId, dir,
        ]);
        console.log(`${line}\n  staged for ${terminal.tty} (${terminal.via}).`);
        staged += 1;
        if (flags.quit && terminal.pid) {
          // Detach the signal so Codex dying cannot take this process with it.
          const child = spawn('sh', ['-c', `sleep 0.4; kill -TERM ${terminal.pid} 2>/dev/null`], {
            detached: true, stdio: 'ignore',
          });
          child.unref();
          quitting = true;
        }
        continue;
      }
      console.log(`${line}\n  no terminal found for this session; opening it alongside instead.`);
    }

    const how = alongside ? openAlongside(written.sessionId, dir) : (openInTerminal(written.sessionId, dir) && 'opened a new Terminal window');
    // Say what is still running *here*, which is not always Codex: this command
    // is also reachable from inside Claude Code and from a bare shell.
    const host = currentAgent();
    const kept = host === 'codex' ? ' — Codex is still running here'
      : host === 'claude' ? ' — this Claude Code session is untouched' : '';
    if (how) console.log(`${line}\n  ${how}${alongside ? kept : ''}.`);
    else console.log(`${line}\n  nothing here can open a pane; run this yourself:\n  ${resumeCommand(written.sessionId, dir)}`);
  }

  if (staged && quitting && wrapperActive()) {
    console.log('\nClosing Codex now — this terminal will come back as Claude Code.');
  } else if (staged && quitting) {
    // The shell that launched Codex never sourced the wrapper, so nothing is
    // waiting to reopen Claude. Say so plainly rather than leaving the user at
    // a bare prompt wondering where the conversation went.
    console.log(
      '\nClosing Codex now. This terminal\'s shell started before the switchboard' +
      '\nwrapper was installed, so it cannot reopen Claude on its own.' +
      '\n\n  >>> type  cc  at the prompt to finish the handoff. <<<' +
      '\n\nTerminals opened from now on do it by themselves.',
    );
  } else if (staged) {
    console.log(
      '\nType /quit now. If this terminal was opened after the shell wrapper was installed it' +
      '\ncomes back as Claude Code by itself; otherwise run  cc  at the prompt.',
    );
  } else if (verb === 'handoff' && !flags.print) {
    console.log(currentAgent() === 'codex'
      ? '\nThis Codex session is untouched. Close it with /quit when you are ready.'
      : '\nThat Codex session is untouched, and nothing here was closed.');
  }
}

function desktopList(sessions) {
  console.log('Claude desktop sessions:\n');
  sessions.forEach((s, i) => {
    const size = s.bytes > 1e6 ? `${(s.bytes / 1e6).toFixed(0)}MB` : `${Math.round(s.bytes / 1e3)}kB`;
    // Every id starts local_ or local_ditto_, so the prefix carries no signal.
    const id = s.sessionId.replace(/^local_(ditto_)?/, '').slice(0, 12);
    const label = s.title
      ? s.title.slice(0, 44)
      : (s.cwd && !s.cwd.startsWith(desktopRoot()) ? s.cwd.replace(os.homedir(), '~') : '(untitled)');
    console.log(`${String(i + 1).padStart(4)}. ${id.padEnd(12)}  ${ago(s.mtime).padStart(8)}  ${size.padStart(6)}  ${label}`);
  });
  console.log('\nSelect by number, session id prefix, or title; --last takes the newest.');
  console.log('The transcript is copied into this directory\'s project, so it resumes here.');
}

/**
 * Claude desktop (local agent mode) -> Claude Code CLI. The desktop app writes a
 * real Claude Code transcript inside its sandbox, so this is a copy plus a cwd
 * rewrite, not a conversion.
 */
async function desktop(flags, rest, cwd) {
  const sessions = listDesktopSessions({
    limit: flags.limit || 20,
    includeArchived: Boolean(flags.archived),
  });
  if (!sessions.length) {
    console.log(`No Claude desktop sessions with transcripts under ${desktopRoot()}.`);
    process.exitCode = 1;
    return;
  }
  if (!rest.length && !flags.last) { desktopList(sessions); return; }

  const chosen = pickDesktopSession(sessions, rest[0]);
  const target = flags.cwd ? path.resolve(String(flags.cwd)) : cwd;
  const written = materialiseDesktopSession(chosen, target, { rewriteCwd: true });
  const label = `${chosen.sessionId.replace(/^local_(ditto_)?/, '').slice(0, 12)}${chosen.title ? ` "${chosen.title.slice(0, 40)}"` : ''}`;
  const note = written.continued
    ? 'already continued here, keeping your copy'
    : (written.copied ? 'copied' : 'already current');
  const line = `${label} → claude ${written.sessionId.slice(0, 8)} (${note})`;

  if (flags.print) {
    console.log(`${line}\n  ${resumeCommand(written.sessionId, target)}`);
    return;
  }
  if (flags.alongside || flags.window) {
    const how = openAlongside(written.sessionId, target);
    console.log(how
      ? `${line}\n  ${how}.`
      : `${line}\n  nothing here can open a pane; run this yourself:\n  ${resumeCommand(written.sessionId, target)}`);
    return;
  }

  // Same contract as `prepare`: the caller (bin/cc) resumes it in this terminal.
  process.stderr.write(`Claude desktop ${line}\n`);
  process.stdout.write(`${written.sessionId}\t${target}\n`);
}

async function main() {
  const { flags, rest } = parse(process.argv.slice(2));
  const verb = (rest.shift() || 'list').toLowerCase();
  const cwd = process.cwd();

  // Desktop sessions come from Application Support, not ~/.codex, so this runs
  // before the Codex-session check below.
  if (verb === 'desktop') {
    await desktop(flags, rest, cwd);
    return;
  }

  const sessions = listSessions({ limit: flags.limit || 20 });

  if (!sessions.length) {
    console.log('No Codex sessions found under ~/.codex/sessions.');
    process.exitCode = 1;
    return;
  }

  if (verb === 'list') {
    console.log('Recent Codex sessions:\n');
    sessions.forEach((s, i) => {
      const mark = s.cwd === path.resolve(cwd) ? '*' : ' ';
      const size = s.bytes > 1e6 ? `${(s.bytes / 1e6).toFixed(0)}MB` : `${Math.round(s.bytes / 1e3)}kB`;
      const label = s.name ? s.name.slice(0, 44) : (s.cwd || '?');
      console.log(`${mark}${String(i + 1).padStart(3)}. ${s.sessionId.slice(0, 8)}  ${ago(s.mtime).padStart(8)}  ${size.padStart(6)}  ${label}`);
    });
    console.log('\n* = started in this directory. Import with the number, e.g. "1", or --here / --last.');
    console.log('Named threads come from the ChatGPT desktop app; you can select one by name.');
    return;
  }

  if (verb === 'handoff' || verb === 'drain') {
    await handoff(verb, flags, sessions, cwd, rest);
    return;
  }

  const chosen = pick(sessions, flags, rest, cwd);
  const { meta, events, counts, truncated } = await readRollout(chosen.file);
  const fitted = flags.full
    ? { events, trimmed: false }
    : trimEvents(events, { maxChars: flags.budget ? Number(flags.budget) : undefined });
  const entries = eventsToEntries(fitted.events);
  if (!entries.length) throw new Error(`Session ${chosen.sessionId.slice(0, 8)} has no recoverable conversation.`);
  const preamble = buildPreamble({ ...meta, cwd: meta.cwd || chosen.cwd }, counts, truncated || fitted.trimmed);

  if (verb === 'context') {
    console.log(preamble);
    for (const entry of entries) {
      console.log(`\n### ${entry.role === 'user' ? 'You (in Codex)' : 'Codex'}\n${entry.text}`);
    }
    return;
  }

  if (verb !== 'prepare') {
    console.log(`Unknown action "${verb}". Use: list | prepare | context | desktop`);
    process.exitCode = 1;
    return;
  }

  const target = meta.cwd || chosen.cwd || cwd;
  const written = writeTranscript({ cwd: target, entries, preamble });
  process.stderr.write(
    `Imported Codex ${chosen.sessionId.slice(0, 8)} → Claude session ${written.sessionId.slice(0, 8)} ` +
    `(${written.rows} turns, ${counts.commands} commands${truncated || fitted.trimmed ? ', trimmed to fit' : ''})\n`,
  );
  process.stdout.write(`${written.sessionId}\t${target}\n`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
