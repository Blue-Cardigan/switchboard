#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexHome, mergeToCodex } from './lib/mergeToCodex.mjs';
import { rolloutMeta } from './lib/codexToClaude.mjs';
import { openDesktop } from './lib/launch.mjs';

function resolve(selector) {
  if (selector.endsWith('.jsonl') || selector.includes(path.sep)) {
    const file = path.resolve(selector.replace(/^~(?=\/|$)/, os.homedir()));
    if (!fs.existsSync(file)) throw new Error(`No Claude transcript at ${file}.`);
    return file;
  }
  const root = path.join(os.homedir(), '.claude', 'projects');
  const matches = [];
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { projects = []; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    for (const name of fs.readdirSync(path.join(root, project.name))) {
      if (name.startsWith(selector) && name.endsWith('.jsonl')) matches.push(path.join(root, project.name, name));
    }
  }
  if (matches.length !== 1) throw new Error(matches.length
    ? `"${selector}" matches ${matches.length} Claude sessions; use more characters.`
    : `No Claude session id matches "${selector}".`);
  return matches[0];
}

async function main() {
  const args = process.argv.slice(2);
  const selectors = args.filter((arg) => !arg.startsWith('--'));
  if (selectors.length !== 1 || args.some((arg) => arg.startsWith('--') && !['--apply', '--open'].includes(arg))) {
    throw new Error('Usage: mergeToCodex.mjs <Claude session id prefix | transcript path> [--apply] [--open]');
  }
  const file = resolve(selectors[0]);
  const apply = args.includes('--apply');
  const result = await mergeToCodex(file, { apply });
  const ok = ['ready', 'merged', 'up-to-date'].includes(result.status);
  const detail = {
    ready: `would append ${result.turns} turn(s) to ${result.threadId?.slice(0, 8)} (dry run; add --apply)`,
    merged: `appended ${result.turns} turn(s)${result.dropped ? ` (${result.dropped} omitted for length)` : ''} to ${result.threadId?.slice(0, 8)} (backup ${result.backup && path.basename(result.backup)})`,
    'up-to-date': `nothing new for Codex thread ${result.threadId?.slice(0, 8)}`,
    'no-home': 'no original Codex thread recorded',
    'claude-busy': 'Claude is mid-turn; let it finish, then rerun',
    'codex-open': 'Codex thread is open; close it, then rerun',
    error: result.error,
  }[result.status] || result.status;
  console.log(`${ok ? '✓' : '✗'} ${path.basename(file, '.jsonl').padEnd(48)}  ${detail}`);
  if (apply && ok && args.includes('--open')) {
    const home = codexHome(file);
    openDesktop(result.threadId, rolloutMeta(home.rollout).cwd || process.cwd(), 'codex');
  }
  if (!ok) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
