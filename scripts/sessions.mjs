#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { harnesses } from './lib/harness/index.mjs';
import { onPath } from './lib/proc.mjs';

const args = process.argv.slice(2);
const cwdIndex = args.indexOf('--cwd');
const limitIndex = args.indexOf('--limit');
const cwd = path.resolve(cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd());
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 10;
if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
const selector = args.find((arg, i) => /^\d+$/.test(arg) &&
  (limitIndex < 0 || i !== limitIndex + 1) && (cwdIndex < 0 || i !== cwdIndex + 1));
const choices = [];

if (!selector) console.log(`Sessions for ${cwd}`);
for (const harness of Object.values(harnesses)) {
  let rows = [];
  let state = '';
  try {
    if (!harness.capabilities.read || !harness.list) state = 'session listing unavailable';
    else rows = await harness.list({ cwd, limit });
  } catch (error) { state = `listing failed: ${error.message}`; }
  if (!rows.length && !state) state = 'none found';
  if (harness.bin && !onPath(harness.bin)) state += `${state ? ' · ' : ''}CLI not installed`;
  if (!selector) console.log(`\n${harness.label}${state ? ` — ${state}` : ''}`);
  for (const row of rows) {
    const id = row.id || row.threadId || row.sessionId || '?';
    const stamp = row.mtime ? new Date(row.mtime).toISOString().slice(0, 16).replace('T', ' ') : '';
    choices.push({ harness, row, id });
    if (!selector) console.log(`  ${String(choices.length).padStart(2)}. ${stamp}  ${id}  ${row.name || row.title || ''}`.trimEnd());
  }
}
if (selector) {
  const picked = choices[Number(selector) - 1];
  if (!picked) {
    console.error(`Session ${selector} is not in this list. Run sb sessions to see current choices.`);
    process.exit(1);
  }
  const argv = picked.harness.resumeArgv(picked.row.threadId || picked.id);
  const child = spawn(argv[0], argv.slice(1), { cwd: picked.row.cwd || cwd, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
} else console.log('\nOpen a session with: sb sessions NUMBER');
