import fs from 'node:fs';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';

export function sessionsRoot(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  return path.join(codexHome, 'sessions');
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function firstLineJson(file) {
  // session_meta is always the first record; avoid reading 34k-line rollouts to index them.
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, read).toString('utf8');
    const line = text.split('\n')[0];
    return JSON.parse(line);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Index recent Codex sessions cheaply, newest first. */
export function listSessions({ limit = 20, cwd = null, codexHome } = {}) {
  const files = walk(sessionsRoot(codexHome));
  const rows = [];
  for (const file of files) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const meta = firstLineJson(file);
    const payload = meta?.payload || {};
    // A resumed session reuses its original session_id across rollout files, so the
    // per-file id from the filename is what actually disambiguates them.
    const rolloutId = (/rollout-.*?-([0-9a-f]{8}-[0-9a-f-]+)\.jsonl$/.exec(path.basename(file)) || [])[1] || null;
    const sessionId = rolloutId || payload.session_id || payload.id || path.basename(file);
    const sessionCwd = payload.cwd || null;
    if (cwd && sessionCwd !== path.resolve(cwd)) continue;
    rows.push({
      file,
      sessionId,
      threadId: payload.session_id || payload.id || null,
      cwd: sessionCwd,
      startedAt: payload.timestamp || meta?.timestamp || null,
      mtime: stat.mtimeMs,
      bytes: stat.size,
    });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : b?.text || ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function shellCommand(command) {
  if (!Array.isArray(command)) return String(command || '');
  // codex wraps everything as ["/bin/zsh","-lc","<cmd>"]
  const idx = command.indexOf('-lc');
  const raw = idx >= 0 && command[idx + 1] ? command[idx + 1] : command.join(' ');
  return raw.replace(/\s+/g, ' ').trim();
}

const MAX_MESSAGE_CHARS = 6000;
const HEAD_EVENTS = 20;
const TAIL_EVENTS = 500;

function clamp(text, limit = MAX_MESSAGE_CHARS) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… [truncated]`;
}

/**
 * Stream a rollout into an ordered conversation. Reasoning is dropped, shell work is
 * kept as a compact activity trail, and prompts/replies are kept in full up to a cap.
 * Rollouts reach 100MB+, so this never holds the whole file — it keeps the opening and
 * a rolling window of the most recent activity.
 */
export async function readRollout(file, { headEvents = HEAD_EVENTS, tailEvents = TAIL_EVENTS } = {}) {
  const meta = { sessionId: null, cwd: null, startedAt: null, model: null };
  const counts = { user: 0, assistant: 0, commands: 0, fileChanges: 0 };
  const head = [];
  const tail = [];
  let ordinal = 0;
  let dropped = false;

  const push = (event) => {
    const withOrdinal = { ...event, ordinal: ordinal++ };
    if (head.length < headEvents) head.push(withOrdinal);
    tail.push(withOrdinal);
    if (tail.length > tailEvents) { tail.shift(); dropped = true; }
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry.payload || {};

    if (entry.type === 'session_meta') {
      meta.sessionId = payload.session_id || payload.id || meta.sessionId;
      meta.cwd = payload.cwd || meta.cwd;
      meta.startedAt = payload.timestamp || entry.timestamp || meta.startedAt;
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'thread_settings_applied') {
      meta.model = payload.thread_settings?.model || meta.model;
      continue;
    }

    if (entry.type === 'response_item' && payload.type === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue; // developer = harness preamble
      const text = textOf(payload.content);
      if (!text) continue;
      counts[role] += 1;
      push({ kind: 'message', role, text: clamp(text) });
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'item_completed') {
      const item = payload.item || {};
      if (item.type === 'CommandExecution') {
        counts.commands += 1;
        push({ kind: 'activity', text: `$ ${shellCommand(item.command).slice(0, 160)}` });
      } else if (item.type === 'FileChange') {
        counts.fileChanges += 1;
        // changes is a map of path -> {type, content|unified_diff}; keep paths only.
        const paths = Object.keys(item.changes || {}).map((p) => p.split('/').slice(-2).join('/'));
        push({ kind: 'activity', text: `~ edited ${paths.join(', ').slice(0, 160)}` });
      }
    }
  }

  let events;
  if (!dropped) {
    events = tail;
  } else {
    const lastHead = head.length ? head[head.length - 1].ordinal : -1;
    const rest = tail.filter((e) => e.ordinal > lastHead);
    events = [...head, { kind: 'activity', text: '… [middle of this session omitted for length] …', ordinal: -1 }, ...rest];
  }

  return { meta, events, counts, truncated: dropped };
}

/**
 * Fit a session into a context budget. The activity trail is sacrificed before
 * conversation, and the oldest material before the newest, because what Codex did
 * most recently is what the next turn has to build on.
 */
export function trimEvents(events, { maxChars = 120000, maxActivity = 150 } = {}) {
  let working = events;

  const activityCount = working.filter((e) => e.kind === 'activity').length;
  if (activityCount > maxActivity) {
    let allowanceStart = activityCount - maxActivity;
    let seen = 0;
    working = working.filter((e) => {
      if (e.kind !== 'activity') return true;
      seen += 1;
      return seen > allowanceStart;
    });
  }

  const size = (e) => e.text.length + 12;
  let total = working.reduce((n, e) => n + size(e), 0);
  if (total <= maxChars) return { events: working, trimmed: activityCount > maxActivity };

  const head = working.slice(0, 4);
  let used = head.reduce((n, e) => n + size(e), 0);
  const tail = [];
  for (let i = working.length - 1; i >= head.length; i -= 1) {
    const next = size(working[i]);
    if (used + next > maxChars) break;
    tail.unshift(working[i]);
    used += next;
  }
  return {
    events: [...head, { kind: 'activity', text: '… [earlier turns dropped to fit the context budget] …' }, ...tail],
    trimmed: true,
  };
}
