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
import { entryCounts, rolloutEntries, rolloutMeta } from './codexToClaude.mjs';
import { buildPreamble, buildRows, normalise } from './claudeTranscript.mjs';
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
      'by Codex, not by you; treat them as established context.',
      "Codex's tool calls appear as tool calls with their recorded output (outputs may be truncated). Continue the work from here.",
      '',
      '--- Codex turns follow ---',
    ].join('\n');
  }
  return [
    '[Continued in Codex]',
    '',
    `After this point the conversation moved to Codex (thread ${meta.threadId.slice(0, 8)}, working in ${meta.cwd || 'an unknown directory'}).`,
    'The assistant turns below were written by Codex, not by you. Treat them as established context and',
    'honour any commitments in them, but never describe that work as something you did.',
    "Codex's tool calls appear as tool calls with their recorded output (outputs may be truncated).",
    'Continue the work from here.',
    '',
    '--- Codex turns follow ---',
  ].join('\n');
}

/**
 * Append alternating entries to an existing Claude transcript, chained from its
 * current leaf, after backing the file up.
 */
export function appendToTranscript(file, entries, preamble, { title = null } = {}) {
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
  if (typeof title === 'string' && title.trim()) {
    let titled = false;
    for (const { line } of linesFrom(file)) {
      if (!line.includes('custom-title')) continue;
      try { if (JSON.parse(line).type === 'custom-title') { titled = true; break; } } catch { /* Partial row. */ }
    }
    if (!titled) rows.push(
      { type: 'custom-title', customTitle: title, sessionId: leaf.sessionId },
      { type: 'agent-name', agentName: title, sessionId: leaf.sessionId },
    );
  }

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

const RECENT_TOOLS = 40;

function shrinkText(value, limit) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… [trimmed]`;
}

/** A tool round with its outputs cut to `result` chars and large inputs to `input` chars. */
function shrinkRound(entry, { result, input }) {
  return {
    ...entry,
    tools: entry.tools.map((tool) => {
      const shrunk = { ...tool, result: shrinkText(tool.result, result) };
      if (input !== null) {
        shrunk.input = Object.fromEntries(Object.entries(tool.input || {}).map(([k, v]) => (
          [k, typeof v === 'string' ? shrinkText(v, input) : v])));
      }
      return shrunk;
    }),
  };
}

/**
 * Fit merged turns into a context budget, cheapest loss first. Conversation is
 * what the next Claude turn most needs, so older tool output is shortened before
 * anything is dropped: first outputs outside the newest rounds, then large inputs
 * (diffs, file bodies), then every output, then older tool calls altogether. Only
 * if that is not enough is the middle of the conversation dropped, keeping the opening exchange and the newest tail. The Codex thread
 * keeps the full record.
 */
export function fitTurns(turns, threadId, maxChars = MERGE_BUDGET) {
  const size = (t) => t.tools
    ? t.tools.reduce((n, tool) => n + JSON.stringify(tool.input).length + String(tool.result).length + 40, 0)
    : t.text.length + 12;
  const total = (list) => list.reduce((n, t) => n + size(t), 0);
  if (total(turns) <= maxChars) return { turns, dropped: 0 };

  const rounds = turns.map((t, i) => (t.tools ? i : -1)).filter((i) => i >= 0);
  // The newest rounds, up to RECENT_TOOLS calls (always at least the last round),
  // keep their detail longest: they are what the next turn builds on.
  const recent = new Set();
  let counted = 0;
  for (const i of [...rounds].reverse()) {
    if (recent.size && counted + turns[i].tools.length > RECENT_TOOLS) break;
    recent.add(i);
    counted += turns[i].tools.length;
  }
  const stages = [
    (t, i) => (t.tools && !recent.has(i) ? shrinkRound(t, { result: 300, input: null }) : t),
    (t, i) => (t.tools && !recent.has(i) ? shrinkRound(t, { result: 200, input: 600 }) : t),
    (t) => (t.tools ? shrinkRound(t, { result: 400, input: 1200 }) : t),
  ];
  stages.push((t, i) => (t.tools && !recent.has(i) ? shrinkRound(t, { result: 80, input: 160 }) : t));
  stages.push((t) => (t.tools ? shrinkRound(t, { result: 80, input: 160 }) : t));
  let working = turns;
  for (const stage of stages) {
    working = working.map(stage);
    if (total(working) <= maxChars) return { turns: working, dropped: 0, trimmed: true };
  }

  // Still over: drop older tool rounds outright, oldest first, keeping every word of
  // conversation. Each run of dropped rounds leaves a one-line count behind.
  const drop = new Set();
  // Leave room for the one-line counts that replace each dropped run.
  let excess = total(working) - maxChars + 400;
  for (const i of rounds) {
    if (excess <= 0 || recent.has(i)) break;
    drop.add(i);
    excess -= size(working[i]);
  }
  if (drop.size) {
    const thinned = [];
    let run = 0;
    const flushRun = () => {
      if (!run) return;
      thinned.push({ role: 'assistant', text: `[${run} earlier Codex tool call(s) omitted for length]` });
      run = 0;
    };
    working.forEach((t, i) => {
      if (drop.has(i)) { run += t.tools.length; return; }
      flushRun();
      thinned.push(t);
    });
    flushRun();
    working = thinned;
    if (total(working) <= maxChars) return { turns: working, dropped: 0, trimmed: true };
  }

  const head = working.slice(0, 2);
  let used = total(head);
  const tail = [];
  for (let i = working.length - 1; i >= head.length; i -= 1) {
    if (used + size(working[i]) > maxChars) break;
    tail.unshift(working[i]);
    used += size(working[i]);
  }
  const dropped = working.length - head.length - tail.length;
  const marker = {
    role: 'assistant',
    text: `… [${dropped} Codex turn(s) omitted for length; Codex thread ${threadId} holds them in full] …`,
  };
  return { turns: [...head, marker, ...tail], dropped, trimmed: true };
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

  const { entries: turns, cursor } = rolloutEntries(session.file, { from, cwd: session.cwd });
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
  const written = appendToTranscript(target, fitted.turns, header({ threadId, cwd: session.cwd }, continuing), { title: session.name || null });
  saveMerged(key, { threadId, transcript: target, cursor, at: Date.now() });
  return { ...result, ...written, status: 'merged', turns: turns.length, dropped: fitted.dropped };
}

const MARKER = /^\[(Continued in Codex|Imported from Codex|More turns from Codex)/;

function isMarker(row) {
  const content = row?.type === 'user' ? row.message?.content : null;
  return typeof content === 'string' && MARKER.test(content);
}

/**
 * Re-render the section an earlier merge or import wrote, from the same span of the
 * rollout, with the current renderer. Rows one merge writes share one timestamp,
 * which is how the section is found; Claude turns that came after it are re-pointed
 * at the new section's last row, so a conversation continued in Claude stays intact.
 */
export function rerenderSession(session, { apply = false, stopClaude = false, budget = MERGE_BUDGET } = {}) {
  const threadId = session.threadId || session.sessionId;
  const previous = readMerged()[session.file];
  if (!previous?.transcript) return { status: 'not-merged', threadId };
  const target = previous.transcript;
  const result = { threadId, transcript: target, sessionId: path.basename(target, '.jsonl') };
  if (!fs.existsSync(target)) return { ...result, status: 'transcript-missing' };

  const lines = fs.readFileSync(target, 'utf8').split('\n').filter((l) => l.trim());
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const markers = rows.map((r, i) => (isMarker(r) ? i : -1)).filter((i) => i >= 0);
  if (markers.length !== 1) return { ...result, status: 'unsupported', detail: `${markers.length} merged sections` };

  const m = markers[0];
  const stamp = rows[m].timestamp;
  let start = m;
  while (start > 0 && rows[start - 1]?.timestamp === stamp && rows[start - 1]?.uuid) start -= 1;
  let end = m;
  while (end + 1 < rows.length && rows[end + 1]?.timestamp === stamp) end += 1;
  const fresh = isMarker(rows[m]) && rows[m].message.content.startsWith('[Imported from Codex]');

  const from = fresh ? 0 : importBoundary(session.file).offset;
  const { entries } = rolloutEntries(session.file, { from, to: previous.cursor, cwd: session.cwd });
  if (!entries.length) return { ...result, status: 'empty' };
  const fitted = fitTurns(entries, threadId, budget);
  if (!apply) return { ...result, status: 'ready-rerender', turns: entries.length, dropped: fitted.dropped };

  let live = claudeLivePids(result.sessionId);
  if (live.length && live.busy.length) return { ...result, status: 'claude-busy', pids: live.busy };
  if (live.length && stopClaude) live = stopPids(live);
  if (live.length) return { ...result, status: 'claude-live', pids: live };

  const first = rows[start];
  const base = {
    isSidechain: false,
    userType: first.userType || 'external',
    entrypoint: first.entrypoint || 'cli',
    cwd: first.cwd,
    sessionId: first.sessionId,
    version: first.version,
    gitBranch: first.gitBranch || '',
  };
  const preamble = fresh
    ? buildPreamble({ ...rolloutMeta(session.file), sessionId: threadId, cwd: base.cwd }, entryCounts(entries),
      Boolean(fitted.dropped), undefined, { structured: true })
    : header({ threadId, cwd: session.cwd }, false);
  const merged = normalise(fitted.turns);
  const all = merged[0]?.role === 'user'
    ? [{ role: 'user', text: `${preamble}\n\n${merged[0].text}` }, ...merged.slice(1)]
    : [{ role: 'user', text: preamble }, ...merged];
  const fresh_rows = buildRows(all, { base, parentUuid: first.parentUuid ?? null, timestamp: stamp });

  // Everything that pointed into the old section now points at the new one's end.
  const oldIds = new Set(rows.slice(start, end + 1).map((r) => r?.uuid).filter(Boolean));
  const newLast = fresh_rows.at(-1).uuid;
  const after = rows.slice(end + 1).map((r) => {
    if (!r) return r;
    const out = { ...r };
    for (const key of ['parentUuid', 'logicalParentUuid', 'leafUuid']) {
      if (oldIds.has(out[key])) out[key] = newLast;
    }
    return out;
  });
  const kept = rows.slice(start, end + 1).filter((r) => r && !r.uuid && r.type !== 'user' && r.type !== 'assistant');
  const hasTitle = rows.some((r) => r?.type === 'custom-title');
  const titleRows = !hasTitle && session.name
    ? [{ type: 'custom-title', customTitle: session.name, sessionId: base.sessionId },
       { type: 'agent-name', agentName: session.name, sessionId: base.sessionId }]
    : [];

  fs.mkdirSync(BACKUPS, { recursive: true });
  const backup = path.join(BACKUPS, `${result.sessionId}.${Date.now()}.jsonl`);
  fs.copyFileSync(target, backup);
  const out = [...rows.slice(0, start), ...fresh_rows, ...kept, ...titleRows, ...after]
    .filter(Boolean).map((r) => JSON.stringify(r)).join('\n');
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${out}\n`);
  fs.renameSync(tmp, target);
  return { ...result, status: 'rerendered', turns: entries.length, dropped: fitted.dropped, backup, rows: fresh_rows.length };
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
