#!/usr/bin/env node
// Merge switchboard's hooks (routing, usage-limit handoff) into ~/.codex/hooks.json, or take it
// back out. That file is the user's, and usually already has hooks in it, so
// this edits only our entries and leaves everything else exactly as it found it.
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
// Anything of ours runs a script out of this checkout's scripts/ directory.
const MARKERS = ['scripts/route-codex.mjs', 'scripts/on-limit.mjs'];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${file} is not readable JSON: ${err.message}`);
  }
}

/** Our entries per event, with the checkout path baked in — Codex expands no variables here. */
function entries() {
  const fragment = readJson(FRAGMENT, null);
  const events = fragment?.hooks;
  if (!events || !Object.keys(events).length) throw new Error(`${FRAGMENT} has no hooks.`);
  return JSON.parse(JSON.stringify(events).replaceAll('${SWITCHBOARD_HOME}', HOME));
}

function isOurs(item) {
  const text = JSON.stringify(item || {});
  return MARKERS.some((marker) => text.includes(marker));
}

function main() {
  const verb = (process.argv[2] || 'status').toLowerCase();
  const config = readJson(TARGET, {});
  const hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  const ours = entries();
  const events = [...new Set([...Object.keys(ours), ...Object.keys(hooks)])];

  if (verb === 'status') {
    const missing = Object.keys(ours).filter((event) => !(hooks[event] || []).some(isOurs));
    console.log(!missing.length ? `installed in ${TARGET}`
      : missing.length === Object.keys(ours).length ? `not installed in ${TARGET}`
        : `partly installed in ${TARGET} (missing: ${missing.join(', ')}) — run install`);
    return;
  }
  if (verb !== 'install' && verb !== 'remove') {
    console.error(`Unknown action "${verb}". Use: install | remove | status`);
    process.exitCode = 1;
    return;
  }

  const merged = { ...config, hooks: { ...hooks } };
  for (const event of events) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const theirs = existing.filter((item) => !isOurs(item));
    const next = verb === 'install' && ours[event] ? [...theirs, ...ours[event]] : theirs;
    if (next.length) merged.hooks[event] = next;
    else delete merged.hooks[event];
  }
  if (!Object.keys(merged.hooks).length) delete merged.hooks;

  // Nothing to do is the common case on a re-run; say so rather than rewriting.
  if (JSON.stringify(merged) === JSON.stringify(config)) {
    console.log(verb === 'install' ? 'already installed' : 'not installed');
    return;
  }

  if (fs.existsSync(TARGET)) fs.copyFileSync(TARGET, `${TARGET}.bak-switchboard`);
  fs.mkdirSync(CODEX_HOME, { recursive: true });
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
