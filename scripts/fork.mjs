#!/usr/bin/env node
// Duplicate the Claude Code conversation running here into a second one, so both
// are live: a side chat that starts with everything this one knows.
//   fork.mjs [--print] [--model <id>] [--cwd DIR]
import path from 'node:path';
import { get, host, supporting } from './lib/harness/index.mjs';
import { openAlongside, resumeCommand } from './lib/launch.mjs';

function parse(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cwd' || arg === '--model' || arg === '--harness') { flags[arg.slice(2)] = argv[++i]; continue; }
    if (arg.startsWith('--')) flags[arg.slice(2)] = true;
  }
  return flags;
}

function main() {
  const flags = parse(process.argv.slice(2));
  const cwd = path.resolve(flags.cwd || process.cwd());

  // Which harness are we forking inside? Not every one can: Codex only writes
  // conversations through its own importer, so a fork there is a round trip.
  const harness = flags.harness ? get(flags.harness) : host();
  if (!harness) {
    throw new Error(`No harness detected here. Name one with --harness (${supporting('fork').map((h) => h.id).join(', ')}).`);
  }
  if (!harness.capabilities.fork) {
    throw new Error(
      `${harness.label} cannot fork a conversation in place — it has no way to write one ` +
      `except through another harness.\nForkable here: ${supporting('fork').map((h) => h.id).join(', ') || 'none'}.`,
    );
  }

  const live = harness.live(cwd);
  if (!live) {
    throw new Error(
      `No ${harness.label} conversation found for ${cwd}.\n` +
      'A fork copies the session you are in; start one here first.',
    );
  }

  const forked = harness.fork({ source: live.source, cwd: live.cwd || cwd, model: flags.model || null });
  const dir = live.cwd || cwd;
  const line = `${path.basename(live.source).slice(0, 8)} → fork ${forked.id.slice(0, 8)} · ` +
    `${forked.rows} turns (${live.via})`;

  if (flags.print) {
    console.log(`${line}\n  ${resumeCommand(forked.id, dir, harness.id)}`);
    return;
  }

  const how = openAlongside(forked.id, dir, harness.id);
  if (how) console.log(`${line}\n  ${how} — this conversation is untouched.`);
  else console.log(`${line}\n  nothing here can open a pane; run this yourself:\n  ${resumeCommand(forked.id, dir, harness.id)}`);
}

try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
