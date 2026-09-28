#!/usr/bin/env node
// Hook: when the harness running this conversation hits its usage limit, hand
// the conversation to another one and open it beside this session.
//
//   Claude Code  StopFailure (matcher rate_limit|billing_error)   node on-limit.mjs claude
//   Codex        Stop, with the rollout's last turn ending in
//                usage_limit_exceeded                             node on-limit.mjs codex
//
// Opened beside, never in place: the limited session stays where it is, to be
// resumed when its limit resets. Must fail open and stay quiet — this runs at
// the end of every failed turn in every project.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as config from './lib/config.mjs';
import { LOG_DIR, ROOT } from './lib/state.mjs';
import { harnesses } from './lib/harness/index.mjs';
import { onPath } from './lib/proc.mjs';
import { rolloutForSession } from './lib/currentSession.mjs';

const HANDOFF = fileURLToPath(new URL('./handoff.mjs', import.meta.url));
const FIRED = path.join(ROOT, 'limit-fired.json');
// One handoff per session per window. A limited session fails every turn you
// try in it, and each of those must not open another pane.
const QUIET_MS = 30 * 60e3;
const CLAUDE_LIMIT_ERRORS = new Set(['rate_limit', 'billing_error']);
const COUNTERPART = { claude: 'codex', codex: 'claude' };

function log(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'on-limit.log'), `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never throw */ }
}

/** The last completed Codex turn, read from the tail of its rollout. */
export function codexTurnHitLimit(file) {
  let text = '';
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return false;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"task_complete"')) continue;
    try {
      const row = JSON.parse(lines[i]);
      if (row.payload?.type !== 'task_complete') continue;
      return row.payload.error?.codex_error_info === 'usage_limit_exceeded';
    } catch { /* a cut-off first line of the window */ }
  }
  return false;
}

/**
 * Where the conversation goes: the configured harness, or with 'recent' the
 * installed harness other than this one whose newest session here is newest.
 * Claude and Codex fall back to each other when nothing else has been used.
 */
export async function pickTarget(source, cwd, preference) {
  const usable = (h) => h && h.id !== source && h.capabilities.write && !h.legacy && (!h.bin || onPath(h.bin));
  if (preference && preference !== 'recent') {
    const named = harnesses[preference];
    return usable(named) ? named.id : null;
  }
  let best = null;
  for (const h of Object.values(harnesses)) {
    if (!usable(h) || !h.list) continue;
    try {
      const [row] = await h.list({ cwd, limit: 1 });
      if (row?.mtime && (!best || row.mtime > best.mtime)) best = { id: h.id, mtime: row.mtime };
    } catch { /* one broken adapter must not stop the rest */ }
  }
  if (best) return best.id;
  return usable(harnesses[COUNTERPART[source]]) ? COUNTERPART[source] : null;
}

function alreadyFired(sessionId) {
  let fired = {};
  try { fired = JSON.parse(fs.readFileSync(FIRED, 'utf8')); } catch { /* none yet */ }
  const now = Date.now();
  for (const [id, at] of Object.entries(fired)) if (now - at > QUIET_MS) delete fired[id];
  const seen = Boolean(fired[sessionId]);
  if (!seen) fired[sessionId] = now;
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(FIRED, JSON.stringify(fired));
  } catch { /* a missed debounce only costs a second pane */ }
  return seen;
}

async function main() {
  const source = process.argv[2];
  // A routed turn is `claude -p` / `codex exec` run by the other router; its
  // failure is reported back through that router, not by opening panes.
  if (process.env.SWITCHBOARD_ROUTED === '1' || !COUNTERPART[source]) return;

  const settings = config.load().onLimit;
  if (!settings.enabled) return;

  let event = {};
  try { event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return; }
  const cwd = event.cwd || process.cwd();

  let file = null;
  if (source === 'claude') {
    if (!CLAUDE_LIMIT_ERRORS.has(event.error)) return;
    file = event.transcript_path || null;
  } else {
    file = event.transcript_path || rolloutForSession(event.session_id || null, cwd);
    if (!file || !codexTurnHitLimit(file)) return;
  }
  if (!file || alreadyFired(event.session_id || file)) return;

  const target = await pickTarget(source, cwd, settings.target);
  if (!target) {
    log(`${source} hit its limit in ${cwd}; no usable target for "${settings.target}"`);
    return;
  }

  const args = [HANDOFF, '--to', target, '--from', source, '--cwd', cwd, '--source', file];
  if (settings.start) args.push('--prompt', settings.prompt);
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 110e3 });
  log(`${source} hit its limit (${event.error || 'usage_limit_exceeded'}) in ${cwd} → ${target}` +
    `${settings.start ? ' (started)' : ''}: ${(run.stdout || run.stderr || '').trim().replace(/\n/g, ' | ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => log(`crashed: ${err && err.stack ? err.stack : err}`));
}
