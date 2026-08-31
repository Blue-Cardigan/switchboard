#!/usr/bin/env node
// CLI behind the /switchboard:* commands and `cx2cc switch`. Prints plain text
// for the calling agent to relay.
//
// Routing runs in both directions, so everything here is written in terms of a
// harness (the agent you are typing into) and a mode (the agent that answers).
// mode === harness means nothing is being routed.
import * as state from './lib/state.mjs';
import { runCodex } from './lib/codex.mjs';
import { runClaude } from './lib/claude.mjs';
import { readTurnsSince, renderBriefing } from './lib/transcript.mjs';
import { readCodexTurnsSince } from './lib/codexTurns.mjs';
import { rolloutForSession } from './lib/currentSession.mjs';
import { findTranscript } from './lib/project.mjs';
import { currentAgent } from './lib/agentContext.mjs';

const VALUE_FLAGS = new Set(['profile', 'model', 'effort', 'sandbox', 'relay', 'permission-mode', 'harness']);
const BOOL_FLAGS = new Set(['fresh', 'seed', 'no-seed']);

const OTHER = { claude: 'codex', codex: 'claude' };
const LABEL = { claude: 'Claude', codex: 'Codex' };
// How the user gets the conversation back, from inside each harness.
const BACK = { claude: '/switchboard:switch claude', codex: '!cx2cc switch codex' };
const AWAY = { claude: '/switchboard:switch codex', codex: '!cx2cc switch claude' };

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { rest.push(arg); continue; }
    const [name, inline] = arg.slice(2).split('=');
    if (VALUE_FLAGS.has(name)) {
      flags[name] = inline ?? argv[++i];
    } else if (BOOL_FLAGS.has(name)) {
      flags[name] = true;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

function settings(s, target) {
  if (target === 'codex') {
    return `  profile ${s.profile || 'default'}${s.model ? `, model ${s.model}` : ''}` +
      `${s.effort ? `, effort ${s.effort}` : ''}${s.sandbox ? `, sandbox ${s.sandbox}` : ''}`;
  }
  return `  model ${s.model || 'default'}${s.permissionMode ? `, permissions ${s.permissionMode}` : ''}`;
}

function describe(s, harness) {
  const other = OTHER[harness];
  if (s.mode === harness) {
    return `Switchboard: ${harness} (this conversation is answered by ${LABEL[harness]}).${
      s.threadId ? `\nDormant ${LABEL[other]} thread ${s.threadId.slice(0, 8)} — ${AWAY[harness]} resumes it.` : ''
    }`;
  }
  const escape = harness === 'claude'
    ? '  Slash commands, ! bash and prompts starting "claude:" still go to Claude.'
    : '  Slash commands, ! bash and prompts starting "codex:" still go to Codex.';
  const lines = [
    `Switchboard: ${other} — your next prompts go to ${LABEL[other]}, not ${LABEL[harness]}.`,
    settings(s, other),
    `  relay ${s.relay}, context seeding ${s.seed ? 'on' : 'off'}`,
    `  thread ${s.threadId ? s.threadId.slice(0, 8) : 'not started'}, ${s.turns} turn(s)`,
    escape,
    `  Back to ${LABEL[harness]}: ${BACK[harness]}`,
  ];
  if (s.lastError) lines.push(`  last error: ${s.lastError}`);
  return lines.join('\n');
}

function applyFlags(s, flags) {
  const next = { ...s };
  for (const key of VALUE_FLAGS) {
    if (key === 'harness') continue;
    if (flags[key] === undefined) continue;
    next[key === 'permission-mode' ? 'permissionMode' : key] = flags[key];
  }
  if (flags['no-seed']) next.seed = false;
  if (flags.seed) next.seed = true;
  if (next.relay && !['verbatim', 'quiet'].includes(next.relay)) next.relay = 'verbatim';
  return next;
}

/** The turns the other agent has not seen yet, rendered as a briefing. */
function catchUp(s, harness, cwd, prompt) {
  if (!s.seed) return { briefing: '', cursor: s.transcriptCursor };

  const source = harness === 'claude'
    ? findTranscript(cwd)
    : rolloutForSession(process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || null, cwd);
  if (!source) return { briefing: '', cursor: s.transcriptCursor };

  const read = harness === 'claude'
    ? readTurnsSince(source, s.transcriptCursor)
    : readCodexTurnsSince(source, s.transcriptCursor);
  const rendered = renderBriefing(read.turns, prompt, { assistantLabel: LABEL[harness] });
  if (!rendered) return { briefing: '', cursor: read.cursor };

  const opener = s.threadId
    ? `${LABEL[harness]} handled these turns since you last replied. Catch up, then answer the request that follows.`
    : `You are joining an in-progress ${LABEL[harness]} conversation. Transcript so far:`;
  return { briefing: `${opener}\n\n${rendered}\n\n--- end transcript ---\n\n`, cursor: read.cursor };
}

async function oneShot(cwd, current, prompt, flags, harness) {
  const s = applyFlags(current, flags);
  const other = OTHER[harness];
  const { briefing, cursor } = catchUp(s, harness, cwd, prompt);

  process.stderr.write(`switchboard → ${other} (${(other === 'codex' ? s.profile : s.model) || 'default'})…\n`);
  const onProgress = (line) => process.stderr.write(`  · ${line}\n`);
  const threadId = flags.fresh ? null : s.threadId;

  const result = other === 'codex'
    ? await runCodex({
        prompt: `${briefing}${prompt}`,
        cwd,
        threadId,
        profile: s.profile,
        model: s.model,
        effort: s.effort,
        sandbox: s.sandbox,
        onProgress,
      })
    : await runClaude({
        prompt: `${briefing}${prompt}`,
        cwd,
        sessionId: threadId,
        model: s.model,
        permissionMode: s.permissionMode,
        onProgress,
      });

  const nextThread = result.threadId ?? result.sessionId ?? s.threadId;

  if (!result.ok) {
    state.save(cwd, { ...s, threadId: nextThread, lastError: result.error }, harness);
    console.log(`${LABEL[other]} failed: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  state.save(cwd, {
    ...s,
    threadId: nextThread,
    transcriptCursor: cursor,
    turns: (s.turns || 0) + 1,
    lastError: null,
  }, harness);
  console.log(result.message);
}

async function main() {
  const cwd = process.cwd();
  const argv = process.argv.slice(2);
  const { flags, rest } = parse(argv);
  // A slash command always runs inside Claude; `cx2cc switch` can be either, so
  // it asks the process tree. --harness overrides both.
  const harness = flags.harness || currentAgent() || 'claude';
  if (!OTHER[harness]) {
    console.log(`Unknown harness "${harness}". Use --harness claude or --harness codex.`);
    process.exitCode = 1;
    return;
  }
  const verb = (rest.shift() || 'status').toLowerCase();
  const current = state.load(cwd, harness);

  switch (verb) {
    case 'status':
      console.log(describe(current, harness));
      return;

    case 'on':
    case 'off':
    case 'claude':
    case 'codex': {
      // `on`/`off` are relative to the harness; the agent names are absolute.
      const target = verb === 'on' ? OTHER[harness] : (verb === 'off' ? harness : verb);
      let next = applyFlags({ ...current, mode: target }, flags);
      if (flags.fresh) next = state.resetThread(next);
      // Unclaimed: the next prompt submitted in this directory adopts the mode.
      next.sessionId = null;
      const saved = state.save(cwd, next, harness);
      const summary = target === harness && current.turns
        ? `\n${LABEL[OTHER[harness]]} answered ${current.turns} turn(s) in thread ${(current.threadId || '').slice(0, 8)};` +
          ` that exchange is in your context. Resume it any time with ${AWAY[harness]}.`
        : '';
      console.log(`${describe(saved, harness)}${summary}`);
      return;
    }

    case 'toggle': {
      const target = current.mode === harness ? OTHER[harness] : harness;
      process.argv = [process.argv[0], process.argv[1], target, ...argv.filter((a) => a !== 'toggle')];
      await main();
      return;
    }

    case 'reset': {
      console.log(describe(state.save(cwd, state.resetThread(current), harness), harness));
      return;
    }

    case 'ask': {
      const prompt = rest.join(' ').trim();
      if (!prompt) { console.log('Nothing to ask. Usage: /switchboard:ask <prompt>'); return; }
      await oneShot(cwd, current, prompt, flags, harness);
      return;
    }

    default:
      console.log(`Unknown action "${verb}". Use: status | claude | codex | toggle | reset | ask <prompt>`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.log(`Switchboard error: ${err.message}`);
  process.exitCode = 1;
});
