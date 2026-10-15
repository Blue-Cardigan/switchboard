#!/usr/bin/env node
// Bring Codex threads back into Claude: merge the Codex turns of a conversation that
// began in Claude into its original transcript, or import one that began in Codex
// as a new Claude conversation. Repeatable — each run appends only turns added in
// Codex since the last one.
//   merge.mjs [selector...] [--imported] [--apply] [--archive] [--stop-claude] [--open] [--budget <chars>]
// Selector: rollout id prefix, thread name, or rollout path. --imported takes every
// recent thread that Codex imported from Claude. Without --apply it only reports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSessions, readRollout, trimEvents } from './lib/codexRollout.mjs';
import { buildPreamble, eventsToEntries, writeTranscript } from './lib/claudeTranscript.mjs';
import {
  archiveCodexThread, codexTurnState, mergeSession, originTranscript, readMerged, recordFreshImport,
} from './lib/mergeBack.mjs';
import { openDesktop } from './lib/launch.mjs';

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit' || arg === '--budget') { flags[arg.slice(2)] = Number(argv[++i]); continue; }
    if (arg.startsWith('--')) { flags[arg.slice(2)] = true; continue; }
    rest.push(arg);
  }
  return { flags, rest };
}

/** Matches that are all rollouts of one thread resolve to its newest (sessions are newest first). */
function single(matches) {
  const threads = new Set(matches.map((s) => s.threadId || s.sessionId));
  return threads.size === 1 ? matches[0] : null;
}

function resolve(sessions, selector) {
  if (selector.endsWith('.jsonl')) {
    const file = path.resolve(selector.replace(/^~/, os.homedir()));
    const known = sessions.find((s) => s.file === file);
    if (known) return known;
    throw new Error(`${file} is not among the recent Codex sessions; raise --limit.`);
  }
  const byId = sessions.filter((s) => s.sessionId.startsWith(selector) || s.threadId?.startsWith(selector));
  if (byId.length && single(byId)) return single(byId);
  if (byId.length > 1) throw new Error(`"${selector}" matches ${byId.length} sessions; use more characters.`);
  const needle = selector.toLowerCase();
  const named = sessions.filter((s) => (s.name || '').toLowerCase().includes(needle));
  if (named.length && single(named)) return single(named);
  if (named.length > 1) throw new Error(`"${selector}" matches ${named.length} thread names: ${named.map((s) => s.name).join('; ')}`);
  throw new Error(`No Codex session id or thread name matches "${selector}".`);
}

/** A thread that began in Codex: write it as a new Claude conversation. */
async function importFresh(session, flags) {
  if (codexTurnState(session.file).inFlight) return { status: 'codex-busy' };
  const cursor = fs.statSync(session.file).size;
  if (!flags.apply) return { status: 'ready-new' };
  const { meta, events, counts, truncated } = await readRollout(session.file);
  const fitted = trimEvents(events);
  const entries = eventsToEntries(fitted.events);
  if (!entries.length) return { status: 'empty' };
  const cwd = meta.cwd || session.cwd || process.cwd();
  const preamble = buildPreamble({ ...meta, cwd }, counts, truncated || fitted.trimmed);
  const written = writeTranscript({ cwd, entries, preamble });
  recordFreshImport(session, written.file, cursor);
  return { status: 'imported-new', transcript: written.file, sessionId: written.sessionId, cwd, rows: written.rows };
}

async function main() {
  const { flags, rest } = parse(process.argv.slice(2));
  const sessions = listSessions({ limit: flags.limit || 400 });
  const merged = readMerged();

  let targets;
  if (flags.imported) {
    targets = sessions.filter((s) => merged[s.file] || originTranscript(s.threadId || s.sessionId));
  } else if (rest.length) {
    targets = rest.map((sel) => resolve(sessions, sel));
  } else {
    console.log('Usage: merge.mjs [selector...] [--imported] [--apply] [--archive] [--stop-claude] [--open]');
    process.exit(1);
  }

  // One rollout per thread: a thread can span several rollout files, newest wins.
  const seen = new Set();
  targets = targets.filter((s) => {
    const id = s.threadId || s.sessionId;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  let failed = 0;
  for (const session of targets) {
    const label = (session.name || session.sessionId).slice(0, 48);
    let result;
    try {
      const hasHome = merged[session.file] || originTranscript(session.threadId || session.sessionId);
      result = hasHome
        ? mergeSession(session, {
          apply: Boolean(flags.apply),
          stopClaude: Boolean(flags['stop-claude']),
          ...(flags.budget ? { budget: flags.budget } : {}),
        })
        : await importFresh(session, flags);
    } catch (error) {
      result = { status: 'error', error: error.message };
    }

    const ok = ['merged', 'imported-new', 'up-to-date', 'ready', 'ready-new'].includes(result.status);
    if (!ok) failed += 1;
    const detail = {
      merged: `appended ${result.turns} turn(s)${result.dropped ? ` (${result.dropped} omitted for length)` : ''} to ${result.sessionId?.slice(0, 8)} (backup ${result.backup && path.basename(result.backup)})`,
      'imported-new': `new Claude conversation ${result.sessionId?.slice(0, 8)}`,
      'up-to-date': result.continuing
        ? `nothing new since the last merge into ${result.sessionId?.slice(0, 8)}`
        : `no Codex turns since it was imported from ${result.sessionId?.slice(0, 8)}`,
      ready: `would append ${result.turns} turn(s) to ${result.sessionId?.slice(0, 8)}`,
      'ready-new': 'began in Codex; would import as a new Claude conversation',
      'codex-busy': 'Codex is mid-turn; stop it or let it finish, then rerun',
      'claude-live': `Claude still has ${result.sessionId?.slice(0, 8)} open (pid ${result.pids?.join(', ')}); close it or pass --stop-claude`,
      'claude-busy': `Claude is mid-turn in ${result.sessionId?.slice(0, 8)} (pid ${result.pids?.join(', ')}); let it finish, then rerun`,
      'transcript-missing': `origin transcript ${result.transcript} is gone`,
      'no-origin': 'no Claude origin recorded',
      empty: 'no recoverable conversation',
      error: result.error,
    }[result.status] || result.status;
    console.log(`${ok ? '✓' : '✗'} ${label.padEnd(48)}  ${detail}`);

    if (flags.apply && ['merged', 'imported-new', 'up-to-date'].includes(result.status)) {
      if (flags.archive) {
        const archived = archiveCodexThread(session.threadId || session.sessionId);
        console.log(`    ${archived === true ? 'archived in Codex' : `could not archive in Codex: ${archived}`}`);
      }
      if (flags.open && result.sessionId) {
        const cwd = result.cwd || session.cwd || process.cwd();
        openDesktop(result.sessionId, cwd, 'claude');
      }
    }
  }
  if (!flags.apply && targets.length) console.log('\nDry run. Add --apply to write.');
  process.exit(failed ? 2 : 0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
