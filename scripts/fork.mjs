#!/usr/bin/env node
// Duplicate the Claude Code conversation running here into a second one, so both
// are live: a side chat that starts with everything this one knows.
//   fork.mjs [--print] [--model <id>] [--cwd DIR]
import path from 'node:path';
import { liveSession, forkTranscript } from './lib/claudeSession.mjs';
import { openAlongside, resumeCommand } from './lib/launch.mjs';

function parse(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cwd' || arg === '--model') { flags[arg.slice(2)] = argv[++i]; continue; }
    if (arg.startsWith('--')) flags[arg.slice(2)] = true;
  }
  return flags;
}

function main() {
  const flags = parse(process.argv.slice(2));
  const cwd = path.resolve(flags.cwd || process.cwd());

  const live = liveSession(cwd);
  if (!live) {
    throw new Error(
      `No Claude Code conversation found for ${cwd}.\n` +
      'A fork copies the session you are in; start one here first.',
    );
  }

  const forked = forkTranscript({ source: live.source, cwd: live.cwd || cwd, model: flags.model || null });
  const dir = live.cwd || cwd;
  const line = `${path.basename(live.source).slice(0, 8)} → fork ${forked.sessionId.slice(0, 8)} · ` +
    `${forked.rows} turns (${live.via})`;

  if (flags.print) {
    console.log(`${line}\n  ${resumeCommand(forked.sessionId, dir)}`);
    return;
  }

  const how = openAlongside(forked.sessionId, dir, 'claude');
  if (how) console.log(`${line}\n  ${how} — this conversation is untouched.`);
  else console.log(`${line}\n  nothing here can open a pane; run this yourself:\n  ${resumeCommand(forked.sessionId, dir)}`);
}

try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
