#!/usr/bin/env node
// UserPromptSubmit hook. When this directory is in codex mode, the prompt is
// answered by Codex instead of Claude and the reply is fed back into Claude's
// context. Any failure here must fail open: a broken router must never stop the
// user from talking to Claude.
import fs from 'node:fs';
import path from 'node:path';
import * as state from './lib/state.mjs';
import { readTurnsSince, renderBriefing } from './lib/transcript.mjs';
import { runCodex } from './lib/codex.mjs';
import { ttyWriter, contextBlock, errorBlock } from './lib/relay.mjs';

const PASSTHROUGH = /^\s*(?:\/|!|#|claude[:,]\s)/i;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function logFailure(err) {
  try {
    fs.mkdirSync(state.LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(state.LOG_DIR, 'route.log'),
      `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`,
    );
  } catch { /* logging must never throw */ }
}

async function main() {
  // This Claude Code run is itself a routed turn, spawned by the Codex-side
  // router. Answer it here or the two routers bounce the prompt between them.
  if (process.env.SWITCHBOARD_ROUTED === '1') return;

  const raw = readStdin();
  if (!raw.trim()) return;

  const event = JSON.parse(raw);
  const cwd = event.cwd || process.cwd();

  // Fast path: one stat call for every prompt in every project that is not routed.
  if (!state.exists(cwd)) return;

  const current = state.load(cwd);
  if (current.mode !== 'codex') return;

  const sessionId = event.session_id || null;
  if (current.sessionId && sessionId && current.sessionId !== sessionId) return;

  const prompt = event.prompt ?? event.user_prompt ?? event.message ?? '';
  if (typeof prompt !== 'string' || !prompt.trim()) return;
  if (PASSTHROUGH.test(prompt)) return;

  // First routed prompt in this session adopts the pending mode change.
  let live = current;
  if (!live.sessionId && sessionId) live = state.save(cwd, { ...live, sessionId });

  const tty = ttyWriter();
  tty.write(`\n  switchboard → codex (${live.profile || 'default profile'})`);

  let briefing = '';
  let cursor = live.transcriptCursor;
  if (live.seed && event.transcript_path) {
    const read = readTurnsSince(event.transcript_path, live.transcriptCursor);
    cursor = read.cursor;
    const rendered = renderBriefing(read.turns, prompt);
    if (rendered) {
      briefing = [
        live.threadId
          ? 'Claude Code handled these turns since you last replied. Catch up, then answer the request that follows.'
          : 'You are taking over an in-progress Claude Code conversation. Transcript so far:',
        '',
        rendered,
        '',
        '--- end transcript ---',
        '',
      ].join('\n');
    }
  }

  const composed = briefing ? `${briefing}${prompt}` : prompt;

  const result = await runCodex({
    prompt: composed,
    cwd,
    threadId: live.threadId,
    profile: live.profile,
    model: live.model,
    effort: live.effort,
    sandbox: live.sandbox,
    onProgress: (line) => tty.write(`  · ${line}`),
  });

  if (!result.ok) {
    state.save(cwd, { ...live, threadId: result.threadId || live.threadId, lastError: result.error });
    tty.write(`  ! codex failed: ${result.error}\n`);
    tty.close();
    process.stdout.write(errorBlock({ state: live, error: result.error }));
    return;
  }

  const turns = (live.turns || 0) + 1;
  state.save(cwd, {
    ...live,
    threadId: result.threadId || live.threadId,
    transcriptCursor: cursor,
    turns,
    lastError: null,
  });

  if (live.relay === 'quiet') tty.write(`\n${result.message}\n`);
  tty.write('');
  tty.close();

  process.stdout.write(contextBlock({
    state: live,
    threadId: result.threadId || live.threadId,
    reply: result.message,
    turns,
  }));
}

main().catch((err) => {
  logFailure(err);
  // Fail open: emit nothing, let Claude answer normally.
  process.exit(0);
});
