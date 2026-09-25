// Antigravity CLI (`agy`) state on disk.
//
// Unlike the other harnesses, switchboard reads Antigravity but never writes an
// Antigravity conversation. Conversations are protobuf blobs inside a SQLite
// file per conversation, and the binary self-updates in the background — a
// format hand-written today would break silently on some Tuesday. Handing a
// conversation *to* Antigravity therefore goes through the CLI's own front
// door: a seed file, opened with `agy --prompt-interactive`.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fieldsOf, firstText, pickNumber } from './proto.mjs';

const require = createRequire(import.meta.url);

// Step types seen in the wild. Anything else is bookkeeping switchboard skips.
const STEP_USER = 14;
const STEP_ASSISTANT = 15;
const STEP_TOOL = 132;

export function agyDir() {
  return process.env.SWITCHBOARD_AGY_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

export function conversationsDir() {
  return path.join(agyDir(), 'conversations');
}

export function summariesPath() {
  return path.join(agyDir(), 'conversation_summaries.db');
}

export function conversationPath(id) {
  return path.join(conversationsDir(), `${id}.db`);
}

export function sessionIdOf(source) {
  return source ? path.basename(String(source), '.db') : null;
}

export function seedsDir() {
  return path.join(os.homedir(), '.claude', 'switchboard', 'seeds');
}

let sqlite;
function nativeSqlite() {
  if (sqlite !== undefined) return sqlite;
  try {
    // node:sqlite announces itself as experimental on stderr every single time,
    // which would land in the middle of switchboard's own output.
    const listeners = process.listeners('warning');
    process.removeAllListeners('warning');
    process.on('warning', (warning) => {
      if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
      for (const listener of listeners) listener(warning);
    });
    sqlite = require('node:sqlite');
  } catch {
    sqlite = null; // Node < 22.5, or built without it
  }
  return sqlite;
}

/**
 * Rows for a read-only query. Blob columns must be selected through `hex(…)`,
 * which keeps the two backends below returning exactly the same shapes.
 */
function query(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return [];
  const native = nativeSqlite();
  if (native) {
    const db = new native.DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  }
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], { encoding: 'utf8' });
    return out.trim() ? JSON.parse(out) : [];
  } catch (err) {
    throw new Error(
      `Reading ${path.basename(dbPath)} needs either Node 22.5+ (for node:sqlite) or the sqlite3 command: ${err.message}`,
    );
  }
}

function hexToBuffer(value) {
  return Buffer.from(String(value || ''), 'hex');
}

export function fileUri(dir) {
  return `file://${path.resolve(dir).split(path.sep).map(encodeURIComponent).join('/')}`
    .replace(/^file:\/\//, 'file://');
}

/**
 * Conversations Antigravity has recorded for a directory, newest first.
 * The workspace is recorded per conversation, so unlike Gemini this is an
 * exact answer rather than "whatever is newest here".
 */
export function listSessions(cwd, { limit = 20 } = {}) {
  const want = path.resolve(cwd);
  const rows = query(
    summariesPath(),
    'select conversation_id, preview, title, step_count, last_modified_time, workspace_uris, project_id ' +
    'from conversation_summaries order by last_modified_time desc limit 400',
  );

  const matched = [];
  for (const row of rows) {
    let uris = [];
    try { uris = JSON.parse(row.workspace_uris || '[]'); } catch { uris = []; }
    const dirs = uris.map((uri) => {
      try { return path.resolve(decodeURIComponent(new URL(uri).pathname)); } catch { return null; }
    });
    if (!dirs.includes(want)) continue;
    matched.push({
      id: row.conversation_id,
      source: conversationPath(row.conversation_id),
      preview: row.title || row.preview || '',
      steps: row.step_count,
      modified: row.last_modified_time,
      project: row.project_id,
      cwd: want,
    });
    if (matched.length >= limit) break;
  }
  return matched;
}

/** One tool call, as the activity line a preamble shows. */
function toolLine(step) {
  const name = firstText(step, [[5, 4, 2]]) || 'tool';
  const args = firstText(step, [[5, 4, 3]]) || '';
  let target = '';
  try {
    const parsed = JSON.parse(args);
    target = parsed.AbsolutePath || parsed.Command || parsed.CommandLine || parsed.Query || parsed.TargetFile || '';
  } catch {
    target = args.slice(0, 160);
  }
  return { name, line: `- ${name}${target ? `: ${String(target).slice(0, 160)}` : ''}` };
}

/**
 * The turns of an Antigravity conversation. `messages` mirrors the other
 * adapters: `{ type: 'user' | 'agent' | 'tool', text }` in recorded order.
 */
export function readSession(target) {
  const file = String(target || '').endsWith('.db') ? String(target) : conversationPath(target);
  const rows = query(file, 'select idx, step_type, hex(step_payload) as payload from steps order by idx');

  const messages = [];
  for (const row of rows) {
    const step = hexToBuffer(row.payload);
    if (!step.length) continue;
    const type = Number(row.step_type ?? pickNumber(step, [1]));

    if (type === STEP_USER) {
      const text = firstText(step, [[19, 2], [19, 3]]);
      if (text) messages.push({ type: 'user', text });
    } else if (type === STEP_ASSISTANT) {
      // 20.1/20.8 are the reply as shown; 20.3 is the line Antigravity prints
      // above a tool call to say what it is about to do, and is all there is on
      // a step that exists only to introduce one.
      const text = firstText(step, [[20, 1], [20, 8], [20, 3]]);
      if (text) messages.push({ type: 'agent', text });
    } else if (type === STEP_TOOL) {
      const { name, line } = toolLine(step);
      messages.push({ type: 'tool', name, text: line });
    }
  }

  return { id: sessionIdOf(file), file, messages };
}

/** Whether a conversation file looks readable before anything tries to read it. */
export function hasSession(id) {
  return fs.existsSync(conversationPath(id));
}

function labelFromPreamble(preamble) {
  const match = /^\[Imported from ([^\]]+)\]/.exec(String(preamble || ''));
  return match ? match[1] : 'the other harness';
}

function sweepSeeds(dir, keep) {
  for (const name of fs.readdirSync(dir)) {
    const stale = path.join(dir, name);
    try {
      if (stale !== keep && Date.now() - fs.statSync(stale).mtimeMs > 36e5) fs.unlinkSync(stale);
    } catch { /* someone else's to worry about */ }
  }
}

/**
 * Stage the conversation as one Markdown file for `agy --prompt-interactive`.
 * Antigravity assigns the conversation id itself when it starts, so what comes
 * back here is the id of the seed, not of a conversation that exists yet.
 */
export function stageSeed({ cwd, entries, preamble }) {
  const dir = seedsDir();
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const file = path.join(dir, `${id}.md`);
  const label = labelFromPreamble(preamble);

  const body = entries.map((entry) => (
    entry.role === 'user' ? `## You\n\n${entry.text}` : `## ${label}\n\n${entry.text}`
  ));
  fs.writeFileSync(file, `${[preamble, '', ...body].join('\n\n')}\n`, { mode: 0o600 });
  sweepSeeds(dir, file);

  return { id, file, cwd, entries: entries.length };
}

/** Field 1 of a step payload, for callers that want the raw step vocabulary. */
export function stepTypes(file) {
  const rows = query(file, 'select step_type, count(*) as n from steps group by step_type order by step_type');
  return rows.map((row) => ({ type: Number(row.step_type), count: Number(row.n) }));
}

export { fieldsOf };
