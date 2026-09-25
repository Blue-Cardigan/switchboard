#!/usr/bin/env node
// Print the conversation id of the agent running in this terminal. The Claude
// id comes from SessionStart's tty mapping, never from a directory-wide guess.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeProcess } from './lib/claudeSession.mjs';
import { ROOT } from './lib/state.mjs';

export function claudeSessionIdForTty(tty, root = ROOT) {
  if (!tty) return null;
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(root, 'sessions', `${tty}.json`), 'utf8'));
  } catch { return null; }
  if (!record.sessionId || !record.transcriptPath) return null;
  if (path.basename(record.transcriptPath) !== `${record.sessionId}.jsonl`) return null;
  if (!fs.existsSync(record.transcriptPath)) return null;
  return record.sessionId;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const claude = claudeProcess();
  if (claude) {
    const id = claudeSessionIdForTty(claude.tty);
    if (!id) {
      console.error('switchboard: no SessionStart record for this Claude terminal.');
      process.exitCode = 1;
    } else console.log(id);
  } else if (process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID) {
    console.log(process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID);
  } else {
    process.exitCode = 3; // bin/id falls back to the system id command.
  }
}
