// Incremental reader for a Codex rollout — the mirror of transcript.mjs, which
// does the same job for a Claude Code transcript.
//
// The Claude side can afford to re-read its transcript every turn. A rollout
// cannot: they reach hundreds of megabytes. Rollouts are append-only, so the
// cursor here is a byte offset and each turn reads only what was added since.
import fs from 'node:fs';
import { shellCommand, textOf } from './codexRollout.mjs';

const MAX_TURN_CHARS = 4000;
const MAX_DELTA_BYTES = 32 * 1024 * 1024;

// Codex replays its own preamble as user-role messages. They are harness
// scaffolding, not anything the user said, and they are large.
const PREAMBLE = /^\s*<(environment_context|user_instructions|user_shell|switchboard)/i;

function clamp(text, limit = MAX_TURN_CHARS) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… [truncated]`;
}

/**
 * Read rollout turns appended since `fromByte`, newest last, with shell and file
 * activity folded into the assistant turn it belongs to.
 * Returns the turns plus the new cursor.
 */
export function readCodexTurnsSince(file, fromByte = 0) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { turns: [], cursor: fromByte }; }

  // A rotated or truncated rollout invalidates the cursor; start over rather
  // than reading from the middle of a line.
  let start = fromByte > stat.size ? 0 : fromByte;
  let skippedBytes = 0;
  if (stat.size - start > MAX_DELTA_BYTES) {
    skippedBytes = stat.size - start - MAX_DELTA_BYTES;
    start = stat.size - MAX_DELTA_BYTES;
  }

  let chunk = '';
  const fd = fs.openSync(file, 'r');
  try {
    const length = stat.size - start;
    if (length > 0) {
      const buf = Buffer.alloc(length);
      const read = fs.readSync(fd, buf, 0, length, start);
      chunk = buf.subarray(0, read).toString('utf8');
    }
  } catch {
    return { turns: [], cursor: fromByte };
  } finally {
    fs.closeSync(fd);
  }

  // Only whole lines are safe to consume: Codex may be mid-write.
  const lastBreak = chunk.lastIndexOf('\n');
  const cursor = lastBreak === -1 ? start : start + Buffer.byteLength(chunk.slice(0, lastBreak + 1), 'utf8');
  const usable = lastBreak === -1 ? '' : chunk.slice(0, lastBreak);

  const turns = [];
  let pending = [];

  const flush = () => {
    if (!pending.length) return '';
    const block = `\n\n[Codex activity]\n${pending.join('\n')}`;
    pending = [];
    return block;
  };

  // A byte cursor can land mid-line after a rotation, so a leading partial line
  // simply fails to parse and is dropped.
  for (const line of usable.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry.payload || {};

    if (entry.type === 'response_item' && payload.type === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = textOf(payload.content);
      if (!text || PREAMBLE.test(text)) continue;
      if (role === 'assistant') {
        turns.push({ role: 'assistant', text: clamp(`${text}${flush()}`) });
      } else {
        if (pending.length) turns.push({ role: 'assistant', text: clamp(flush().trim()) });
        turns.push({ role: 'user', text: clamp(text) });
      }
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'item_completed') {
      const item = payload.item || {};
      if (item.type === 'CommandExecution') {
        pending.push(`$ ${shellCommand(item.command).slice(0, 160)}`);
      } else if (item.type === 'FileChange') {
        const paths = Object.keys(item.changes || {}).map((p) => p.split('/').slice(-2).join('/'));
        pending.push(`~ edited ${paths.join(', ').slice(0, 160)}`);
      }
    }
  }
  if (pending.length) turns.push({ role: 'assistant', text: clamp(flush().trim()) });

  if (skippedBytes && turns.length) {
    turns.unshift({ role: 'assistant', text: `… [${Math.round(skippedBytes / 1e6)}MB of earlier activity omitted] …` });
  }

  return { turns, cursor };
}
