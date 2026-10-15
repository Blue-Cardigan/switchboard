// Merge a Codex thread back into the Claude Code conversation it came from.
//
// When a Claude conversation is imported into Codex (the ChatGPT desktop app's
// sync, or `externalAgentConfig/import`), Codex replays it as turns whose ids are
// `external-import-turn-N` and records the source transcript in its import
// ledgers. Everything after the first turn with any other id happened in Codex.
// Those turns are appended to the original Claude transcript, so the conversation
// keeps its place, title and history in Claude instead of reappearing as a copy.
//
// A cursor per rollout (merged.json) makes this repeatable: an ongoing Codex
// thread can be merged, continued in Codex, and merged again, and only the new
// turns are appended each time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readCodexTurnsSince } from './codexTurns.mjs';
import { buildRows, normalise } from './claudeTranscript.mjs';
import { ROOT } from './state.mjs';

const MERGED = path.join(ROOT, 'merged.json');
const BACKUPS = path.join(ROOT, 'backups');
const IMPORTED_TURN = /^external-import-turn-/;
const CHUNK = 4 * 1024 * 1024;

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function readMerged() {
  try { return JSON.parse(fs.readFileSync(MERGED, 'utf8')); } catch { return {}; }
}

function saveMerged(key, record) {
  const all = readMerged();
  all[key] = record;
  fs.mkdirSync(ROOT, { recursive: true });
  const tmp = `${MERGED}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
  fs.renameSync(tmp, MERGED);
}

const LEDGERS = [
  { file: 'external_agent_session_imports.json', source: 'source_path', thread: 'imported_thread_id', at: 'imported_at' },
  { file: 'claude-cowork-import-history.json', source: 'sourcePath', thread: 'importedThreadId', at: 'importedAtMs' },
];

/** The Claude transcript a Codex thread was imported from, if Codex recorded one that still exists. */
export function originTranscript(threadId) {
  let best = null;
  for (const keys of LEDGERS) {
    let ledger;
    try { ledger = JSON.parse(fs.readFileSync(path.join(codexHome(), keys.file), 'utf8')); } catch { continue; }
    const records = Array.isArray(ledger?.records) ? ledger.records : [];
    for (const r of records) {
      if (r?.[keys.thread] !== threadId || typeof r?.[keys.source] !== 'string') continue;
      // Seconds in one ledger, milliseconds in the other.
      const at = Number(r[keys.at] || 0) * (keys.at === 'imported_at' ? 1000 : 1);
      if (!best || at > best.at) best = { file: r[keys.source], at };
    }
  }
  return best && fs.existsSync(best.file) ? best.file : null;
}

/** Whole lines of a file from `from`, each with the byte offset it starts at. */
function* linesFrom(file, from = 0) {
  const fd = fs.openSync(file, 'r');
  try {
    let offset = from;
    let carry = Buffer.alloc(0);
    const buf = Buffer.alloc(CHUNK);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, CHUNK, offset + carry.length);
      if (read <= 0) break;
      let data = Buffer.concat([carry, buf.subarray(0, read)]);
      let start = 0;
      let nl;
      while ((nl = data.indexOf(10, start)) !== -1) {
        yield { line: data.subarray(start, nl).toString('utf8'), offset: offset + start };
        start = nl + 1;
      }
      offset += start;
      carry = Buffer.from(data.subarray(start));
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Where the Codex-native part of a rollout starts. `imported` is false for a
 * thread that began in Codex; `offset` is the file size when nothing native has
 * happened yet.
 */
export function importBoundary(file) {
  let imported = false;
  for (const { line, offset } of linesFrom(file)) {
    if (!line.includes('"task_started"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const turnId = String(entry.payload?.turn_id || '');
    if (IMPORTED_TURN.test(turnId)) { imported = true; continue; }
    return { imported, offset };
  }
  return { imported, offset: fs.statSync(file).size };
}

/**
 * Whether Codex is mid-turn on this rollout: the last turn started and has not
 * completed or been aborted. Only the tail is read; turns are short next to rollouts.
 */
export function codexTurnState(file) {
  const size = fs.statSync(file).size;
  const from = Math.max(0, size - CHUNK);
  let state = 'idle';
  let at = null;
  for (const { line } of linesFrom(file, from)) {
    if (!/"(task_started|task_complete|turn_aborted)"/.test(line)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const type = entry.payload?.type;
    if (type === 'task_started') state = 'running';
    else if (type === 'task_complete' || type === 'turn_aborted') state = 'idle';
    at = entry.timestamp || at;
  }
  return { inFlight: state === 'running', at };
}

/** Live Claude Code processes that have this conversation open; `.busy` lists those not idle. */
export function claudeLivePids(sessionId) {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const pids = [];
  const busy = new Set();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (record?.sessionId !== sessionId) continue;
    const pid = Number(record.pid || name.replace(/\.json$/, ''));
    try { process.kill(pid, 0); } catch { continue; /* stale registration */ }
    pids.push(pid);
    if (record.status !== 'idle') busy.add(pid);
  }
  return Object.assign(pids, { busy: [...busy] });
}

/** SIGTERM the processes and wait briefly for them to go. Returns the survivors. */
export function stopPids(pids, waitMs = 8000) {
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  const deadline = Date.now() + waitMs;
  let alive = pids;
  while (alive.length && Date.now() < deadline) {
    execFileSync('sleep', ['0.25']);
    alive = alive.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  }
  return alive;
}

/** The last row on the main chain: the leaf a resumed session continues from. */
function lastChainRow(file) {
  const size = fs.statSync(file).size;
  // Rows can be large (tool results), so widen the window until one is found.
  for (let window = 1 << 20; ; window *= 4) {
    const from = Math.max(0, size - window);
    let last = null;
    for (const { line } of linesFrom(file, from)) {
      if (!line.includes('"uuid"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.uuid && !row.isSidechain && row.sessionId) last = row;
    }
    if (last || from === 0) return last;
  }
}

function header(meta, continuing) {
  if (continuing) {
    return [
      `[More turns from Codex, thread ${meta.threadId.slice(0, 8)}]`,
      'The conversation carried on in Codex after the last merge. The assistant turns below were written',
      'by Codex, not by you; treat them as established context. Continue the work from here.',
      '',
      '--- Codex turns follow ---',
    ].join('\n');
  }
  return [
    '[Continued in Codex]',
    '',
    `After this point the conversation moved to Codex (thread ${meta.threadId.slice(0, 8)}, working in ${meta.cwd || 'an unknown directory'}).`,
    'The assistant turns below were written by Codex, not by you. Treat them as established context and',
    'honour any commitments in them, but never describe that work as something you did. Shell commands and',
    'edits are summarised as [Codex activity]; their output is not preserved, so re-read files before',
    'relying on their contents. Continue the work from here.',
    '',
    '--- Codex turns follow ---',
  ].join('\n');
}

/**
 * Append alternating entries to an existing Claude transcript, chained from its
 * current leaf, after backing the file up.
 */
export function appendToTranscript(file, entries, preamble) {
  const leaf = lastChainRow(file);
  if (!leaf) throw new Error(`No conversation rows in ${file}.`);

  fs.mkdirSync(BACKUPS, { recursive: true });
  const backup = path.join(BACKUPS, `${path.basename(file, '.jsonl')}.${Date.now()}.jsonl`);
  fs.copyFileSync(file, backup);

  const base = {
    isSidechain: false,
    userType: leaf.userType || 'external',
    entrypoint: leaf.entrypoint || 'cli',
    cwd: leaf.cwd,
    sessionId: leaf.sessionId,
    version: leaf.version,
    gitBranch: leaf.gitBranch || '',
  };
  const timestamp = new Date().toISOString();
  const rows = [];
  let parentUuid = leaf.uuid;

  // A leaf that is an assistant tool call needs its results before any user text,
  // or the API rejects the rebuilt conversation.
  const pending = leaf.type === 'assistant' && Array.isArray(leaf.message?.content)
    ? leaf.message.content.filter((b) => b?.type === 'tool_use').map((b) => b.id)
    : [];
  if (pending.length) {
    const uuid = crypto.randomUUID();
    rows.push({
      ...base,
      parentUuid,
      type: 'user',
      uuid,
      timestamp,
      message: {
        role: 'user',
        content: pending.map((id) => ({
          type: 'tool_result',
          tool_use_id: id,
          content: 'Interrupted: the conversation continued in Codex.',
          is_error: true,
        })),
      },
    });
    parentUuid = uuid;
  }

  const merged = normalise(entries);
  const all = merged[0]?.role === 'user'
    ? [{ role: 'user', text: `${preamble}\n\n${merged[0].text}` }, ...merged.slice(1)]
    : [{ role: 'user', text: preamble }, ...merged];
  rows.push(...buildRows(all, { base, parentUuid, timestamp }));

  // The file may lack a trailing newline if it was cut short; never glue rows together.
  const fd = fs.openSync(file, 'r');
  const tail = Buffer.alloc(1);
  const size = fs.fstatSync(fd).size;
  if (size) fs.readSync(fd, tail, 0, 1, size - 1);
  fs.closeSync(fd);
  const lead = size && tail[0] !== 10 ? '\n' : '';
  fs.appendFileSync(file, `${lead}${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return { rows: rows.length, backup, sessionId: leaf.sessionId, cwd: leaf.cwd };
}

const MERGE_BUDGET = 200000;

/**
 * Fit merged turns into a context budget: the opening exchange and the newest tail
 * survive, the middle is dropped with a marker. What Codex did most recently is what
 * the next Claude turn has to build on; the Codex thread keeps the full record.
 */
export function fitTurns(turns, threadId, maxChars = MERGE_BUDGET) {
  const size = (t) => t.text.length + 12;
  const total = turns.reduce((n, t) => n + size(t), 0);
  if (total <= maxChars) return { turns, dropped: 0 };
  const head = turns.slice(0, 2);
  let used = head.reduce((n, t) => n + size(t), 0);
  const tail = [];
  for (let i = turns.length - 1; i >= head.length; i -= 1) {
    if (used + size(turns[i]) > maxChars) break;
    tail.unshift(turns[i]);
    used += size(turns[i]);
  }
  const dropped = turns.length - head.length - tail.length;
  const marker = {
    role: 'assistant',
    text: `… [${dropped} Codex turn(s) omitted for length; Codex thread ${threadId} holds them in full] …`,
  };
  return { turns: [...head, marker, ...tail], dropped };
}

/**
 * Plan or perform a merge of one Codex rollout. `session` is a listSessions row.
 * Returns a status record; nothing is written unless `apply` is set and the
 * status is 'ready'.
 */
export function mergeSession(session, { apply = false, stopClaude = false, transcript = null, budget = MERGE_BUDGET } = {}) {
  const key = session.file;
  const threadId = session.threadId || session.sessionId;
  const previous = readMerged()[key];
  const size = fs.statSync(session.file).size;

  let target = transcript || previous?.transcript || originTranscript(threadId);
  let from;
  let continuing = false;
  if (previous && previous.transcript === target && previous.cursor <= size) {
    from = previous.cursor;
    continuing = true;
  } else if (target) {
    const boundary = importBoundary(session.file);
    from = boundary.offset;
  }
  if (!target) return { status: 'no-origin', threadId };

  const result = { threadId, transcript: target, sessionId: path.basename(target, '.jsonl') };
  if (!fs.existsSync(target)) return { ...result, status: 'transcript-missing' };

  const { inFlight } = codexTurnState(session.file);
  if (inFlight) return { ...result, status: 'codex-busy' };

  const { turns, cursor } = readCodexTurnsSince(session.file, from);
  if (!turns.length) {
    if (apply) saveMerged(key, { threadId, transcript: target, cursor, at: Date.now() });
    return { ...result, status: 'up-to-date', turns: 0, continuing };
  }

  let live = claudeLivePids(result.sessionId);
  // Only an idle session is stopped: killing one mid-turn would lose that turn.
  if (live.length && live.busy.length) return { ...result, status: 'claude-busy', pids: live.busy, turns: turns.length };
  if (live.length && stopClaude && apply) live = stopPids(live);
  if (live.length) return { ...result, status: 'claude-live', pids: live, turns: turns.length };

  if (!apply) return { ...result, status: 'ready', turns: turns.length };

  const fitted = fitTurns(turns, threadId, budget);
  const written = appendToTranscript(target, fitted.turns, header({ threadId, cwd: session.cwd }, continuing));
  saveMerged(key, { threadId, transcript: target, cursor, at: Date.now() });
  return { ...result, ...written, status: 'merged', turns: turns.length, dropped: fitted.dropped };
}

/** Record a transcript written from scratch for a thread that began in Codex. */
export function recordFreshImport(session, transcript, cursor) {
  saveMerged(session.file, {
    threadId: session.threadId || session.sessionId,
    transcript,
    cursor,
    at: Date.now(),
  });
}

/** Archive the thread in Codex, so it leaves the ChatGPT sidebar once it lives in Claude. */
export function archiveCodexThread(threadId) {
  try {
    execFileSync('codex', ['archive', threadId], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    return true;
  } catch (error) {
    return String(error.stderr || error.message || error).trim().split('\n').pop();
  }
}
