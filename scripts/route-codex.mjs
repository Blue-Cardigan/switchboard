#!/usr/bin/env node
// UserPromptSubmit hook for Codex — the mirror of route.mjs. When this directory
// is in claude mode, the prompt is answered by Claude Code instead of Codex and
// the reply is fed back into Codex's context. Any failure here must fail open: a
// broken router must never stop the user from talking to Codex.
//
// Codex 0.151's hook system takes the same hooks.json shape and the same
// UserPromptSubmit payload as Claude Code's, so this is the same design running
// the other way round. The one difference is the reply channel: Codex reads
// hookSpecificOutput.additionalContext rather than bare stdout.
import fs from 'node:fs';
import path from 'node:path';
import * as state from './lib/state.mjs';
import { readCodexTurnsSince } from './lib/codexTurns.mjs';
import { renderBriefing } from './lib/transcript.mjs';
import { runClaude } from './lib/claude.mjs';
import { ttyWriter, contextBlock, errorBlock } from './lib/relay.mjs';
import { rolloutForSession } from './lib/currentSession.mjs';

const HARNESS = 'codex';
const BACK = '!cx2cc switch codex';
const PASSTHROUGH = /^\s*(?:\/|!|#|codex[:,]\s)/i;

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
      path.join(state.LOG_DIR, 'route-codex.log'),
      `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`,
    );
  } catch { /* logging must never throw */ }
}

/** Codex reads this shape; bare stdout is not a documented channel. */
function emit(text) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
  })}\n`);
}

function settingsLine(s, sessionId) {
  const bits = [`model ${s.model || 'default'}`];
  if (s.permissionMode) bits.push(`permissions ${s.permissionMode}`);
  if (sessionId) bits.push(`session ${sessionId.slice(0, 8)}`);
  return bits.join(', ');
}

async function main() {
  // This Codex run is itself a routed turn, spawned by the Claude-side router.
  if (process.env.SWITCHBOARD_ROUTED === '1') return;

  const raw = readStdin();
  if (!raw.trim()) return;

  const event = JSON.parse(raw);
  const cwd = event.cwd || process.cwd();

  // Fast path: one stat call for every prompt in every project that is not routed.
  if (!state.exists(cwd, HARNESS)) return;

  const current = state.load(cwd, HARNESS);
  if (current.mode !== 'claude') return;

  const sessionId = event.session_id || null;
  if (current.sessionId && sessionId && current.sessionId !== sessionId) return;

  const prompt = event.prompt ?? event.user_prompt ?? event.message ?? '';
  if (typeof prompt !== 'string' || !prompt.trim()) return;
  if (PASSTHROUGH.test(prompt)) return;

  // First routed prompt in this session adopts the pending mode change.
  let live = current;
  if (!live.sessionId && sessionId) live = state.save(cwd, { ...live, sessionId }, HARNESS);

  const tty = ttyWriter();
  tty.write(`\n  switchboard → claude (${live.model || 'default model'})`);

  // Codex hands the hook a transcript_path on some events but not all; fall back
  // to the rollout this session is writing.
  const rollout = (event.transcript_path && fs.existsSync(event.transcript_path))
    ? event.transcript_path
    : rolloutForSession(sessionId, cwd);

  let briefing = '';
  let cursor = live.transcriptCursor;
  if (live.seed && rollout) {
    const read = readCodexTurnsSince(rollout, live.transcriptCursor);
    cursor = read.cursor;
    const rendered = renderBriefing(read.turns, prompt, { assistantLabel: 'Codex' });
    if (rendered) {
      briefing = [
        live.threadId
          ? 'Codex handled these turns since you last replied. Catch up, then answer the request that follows.'
          : 'You are taking over an in-progress Codex conversation. Transcript so far:',
        '',
        rendered,
        '',
        '--- end transcript ---',
        '',
      ].join('\n');
    }
  }

  const composed = briefing ? `${briefing}${prompt}` : prompt;

  const result = await runClaude({
    prompt: composed,
    cwd,
    sessionId: live.threadId,
    model: live.model,
    permissionMode: live.permissionMode,
    onProgress: (line) => tty.write(`  · ${line}`),
  });

  if (!result.ok) {
    state.save(cwd, { ...live, threadId: result.sessionId || live.threadId, lastError: result.error }, HARNESS);
    tty.write(`  ! claude failed: ${result.error}\n`);
    tty.close();
    emit(errorBlock({
      state: live,
      error: result.error,
      answeredBy: 'Claude Code',
      settings: settingsLine(live, result.sessionId || live.threadId),
      back: BACK,
    }));
    return;
  }

  const turns = (live.turns || 0) + 1;
  state.save(cwd, {
    ...live,
    threadId: result.sessionId || live.threadId,
    transcriptCursor: cursor,
    turns,
    lastError: null,
  }, HARNESS);

  if (live.relay === 'quiet') tty.write(`\n${result.message}\n`);
  tty.write('');
  tty.close();

  emit(contextBlock({
    state: live,
    threadId: result.sessionId || live.threadId,
    reply: result.message,
    turns,
    answeredBy: 'Claude Code',
    headerText: settingsLine(live, result.sessionId || live.threadId),
    back: BACK,
  }));
}

main().catch((err) => {
  logFailure(err);
  // Fail open: emit nothing, let Codex answer normally.
  process.exit(0);
});
