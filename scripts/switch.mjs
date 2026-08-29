#!/usr/bin/env node
// CLI behind the /switchboard:* commands. Prints plain text for Claude to relay.
import * as state from './lib/state.mjs';
import { runCodex } from './lib/codex.mjs';
import { readTurnsSince, renderBriefing } from './lib/transcript.mjs';
import { findTranscript } from './lib/project.mjs';

const VALUE_FLAGS = new Set(['profile', 'model', 'effort', 'sandbox', 'relay']);
const BOOL_FLAGS = new Set(['fresh', 'seed', 'no-seed']);

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

function describe(s) {
  if (s.mode !== 'codex') {
    return `Switchboard: claude (this conversation is answered by Claude).${
      s.threadId ? `\nDormant Codex thread ${s.threadId.slice(0, 8)} — /switchboard:switch codex resumes it.` : ''
    }`;
  }
  const lines = [
    'Switchboard: codex — your next prompts go to Codex, not Claude.',
    `  profile ${s.profile || 'default'}${s.model ? `, model ${s.model}` : ''}${s.effort ? `, effort ${s.effort}` : ''}${s.sandbox ? `, sandbox ${s.sandbox}` : ''}`,
    `  relay ${s.relay}, context seeding ${s.seed ? 'on' : 'off'}`,
    `  thread ${s.threadId ? s.threadId.slice(0, 8) : 'not started'}, ${s.turns} turn(s)`,
    '  Slash commands, ! bash and prompts starting "claude:" still go to Claude.',
    '  Back to Claude: /switchboard:switch claude',
  ];
  if (s.lastError) lines.push(`  last error: ${s.lastError}`);
  return lines.join('\n');
}

function applyFlags(s, flags) {
  const next = { ...s };
  for (const key of VALUE_FLAGS) if (flags[key] !== undefined) next[key] = flags[key];
  if (flags['no-seed']) next.seed = false;
  if (flags.seed) next.seed = true;
  if (next.relay && !['verbatim', 'quiet'].includes(next.relay)) next.relay = 'verbatim';
  return next;
}

async function oneShot(cwd, current, prompt, flags) {
  const s = applyFlags(current, flags);
  const transcript = findTranscript(cwd);
  let composed = prompt;
  let cursor = s.transcriptCursor;

  if (s.seed && transcript) {
    const read = readTurnsSince(transcript, s.transcriptCursor);
    cursor = read.cursor;
    const rendered = renderBriefing(read.turns, prompt);
    if (rendered) {
      composed = `${s.threadId
        ? 'Claude Code handled these turns since you last replied. Catch up, then answer the request that follows.'
        : 'You are joining an in-progress Claude Code conversation. Transcript so far:'}\n\n${rendered}\n\n--- end transcript ---\n\n${prompt}`;
    }
  }

  process.stderr.write(`switchboard → codex (${s.profile || 'default profile'})…\n`);
  const result = await runCodex({
    prompt: composed,
    cwd,
    threadId: flags.fresh ? null : s.threadId,
    profile: s.profile,
    model: s.model,
    effort: s.effort,
    sandbox: s.sandbox,
    onProgress: (line) => process.stderr.write(`  · ${line}\n`),
  });

  if (!result.ok) {
    state.save(cwd, { ...s, threadId: result.threadId || s.threadId, lastError: result.error });
    console.log(`Codex failed: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  state.save(cwd, {
    ...s,
    threadId: result.threadId || s.threadId,
    transcriptCursor: cursor,
    turns: (s.turns || 0) + 1,
    lastError: null,
  });
  console.log(result.message);
}

async function main() {
  const cwd = process.cwd();
  const argv = process.argv.slice(2);
  const { flags, rest } = parse(argv);
  const verb = (rest.shift() || 'status').toLowerCase();
  const current = state.load(cwd);

  switch (verb) {
    case 'status':
      console.log(describe(current));
      return;

    case 'codex':
    case 'on': {
      let next = applyFlags({ ...current, mode: 'codex' }, flags);
      if (flags.fresh) next = state.resetThread(next);
      // Unclaimed: the next prompt submitted in this directory adopts the mode.
      next.sessionId = null;
      console.log(describe(state.save(cwd, next)));
      return;
    }

    case 'claude':
    case 'off': {
      const next = applyFlags({ ...current, mode: 'claude', sessionId: null }, flags);
      const saved = state.save(cwd, next);
      const summary = current.turns
        ? `\nCodex answered ${current.turns} turn(s) in thread ${(current.threadId || '').slice(0, 8)}; that exchange is in your context. Resume it any time with /switchboard:switch codex.`
        : '';
      console.log(`${describe(saved)}${summary}`);
      return;
    }

    case 'toggle': {
      const target = current.mode === 'codex' ? 'claude' : 'codex';
      process.argv = [process.argv[0], process.argv[1], target, ...argv.filter((a) => a !== 'toggle')];
      await main();
      return;
    }

    case 'reset': {
      console.log(describe(state.save(cwd, state.resetThread(current))));
      return;
    }

    case 'ask': {
      const prompt = rest.join(' ').trim();
      if (!prompt) { console.log('Nothing to ask. Usage: /switchboard:ask <prompt>'); return; }
      await oneShot(cwd, current, prompt, flags);
      return;
    }

    default:
      console.log(`Unknown action "${verb}". Use: status | codex | claude | toggle | reset | ask <prompt>`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.log(`Switchboard error: ${err.message}`);
  process.exitCode = 1;
});
