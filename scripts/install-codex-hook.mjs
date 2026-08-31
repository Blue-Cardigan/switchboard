#!/usr/bin/env node
// Merge switchboard's UserPromptSubmit hook into ~/.codex/hooks.json, or take it
// back out. That file is the user's, and usually already has hooks in it, so
// this edits one entry and leaves everything else exactly as it found it.
//
//   node scripts/install-codex-hook.mjs install
//   node scripts/install-codex-hook.mjs remove
//   node scripts/install-codex-hook.mjs status
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const TARGET = path.join(CODEX_HOME, 'hooks.json');
const FRAGMENT = path.join(HOME, 'hooks', 'codex-hooks.json');
const MARKER = 'scripts/route-codex.mjs';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${file} is not readable JSON: ${err.message}`);
  }
}

/** Our entry, with the checkout path baked in — Codex expands no variables here. */
function entry() {
  const fragment = readJson(FRAGMENT, null);
  const ours = fragment?.hooks?.UserPromptSubmit?.[0];
  if (!ours) throw new Error(`${FRAGMENT} has no UserPromptSubmit entry.`);
  return JSON.parse(JSON.stringify(ours).replaceAll('${SWITCHBOARD_HOME}', HOME));
}

function isOurs(item) {
  return JSON.stringify(item || {}).includes(MARKER);
}

function main() {
  const verb = (process.argv[2] || 'status').toLowerCase();
  const config = readJson(TARGET, {});
  const hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  const existing = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
  const mine = existing.filter(isOurs);
  const theirs = existing.filter((item) => !isOurs(item));

  if (verb === 'status') {
    console.log(mine.length ? `installed in ${TARGET}` : `not installed in ${TARGET}`);
    return;
  }
  if (verb !== 'install' && verb !== 'remove') {
    console.error(`Unknown action "${verb}". Use: install | remove | status`);
    process.exitCode = 1;
    return;
  }

  const next = verb === 'install' ? [...theirs, entry()] : theirs;
  // Nothing to do is the common case on a re-run; say so rather than rewriting.
  if (JSON.stringify(next) === JSON.stringify(existing)) {
    console.log(verb === 'install' ? 'already installed' : 'not installed');
    return;
  }

  if (fs.existsSync(TARGET)) fs.copyFileSync(TARGET, `${TARGET}.bak-switchboard`);
  fs.mkdirSync(CODEX_HOME, { recursive: true });

  const merged = { ...config, hooks: { ...hooks } };
  if (next.length) merged.hooks.UserPromptSubmit = next;
  else delete merged.hooks.UserPromptSubmit;
  if (!Object.keys(merged.hooks).length) delete merged.hooks;

  fs.writeFileSync(TARGET, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`${verb === 'install' ? 'added to' : 'removed from'} ${TARGET}` +
    `${fs.existsSync(`${TARGET}.bak-switchboard`) ? ' (backup: hooks.json.bak-switchboard)' : ''}`);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
