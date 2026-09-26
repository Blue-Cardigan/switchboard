#!/usr/bin/env node
// Register SessionStart directly: a skill-directory symlink does not load plugin hooks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const file = path.join(os.homedir(), '.claude', 'settings.json');
const marker = '/scripts/session-start.mjs';
const verb = process.argv[2] || 'status';
let config;
try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  config = {};
}
const hooks = config.hooks || {};
const existing = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
const ours = existing.filter((item) => JSON.stringify(item).includes(marker));
if (verb === 'status') {
  console.log(ours.length ? `installed in ${file}` : `not installed in ${file}`);
} else if (verb === 'install' || verb === 'remove') {
  const next = existing.filter((item) => !JSON.stringify(item).includes(marker));
  if (verb === 'install') next.push({ hooks: [{ type: 'command', command: `node "${root}/scripts/session-start.mjs"`, timeout: 10 }] });
  if (JSON.stringify(next) !== JSON.stringify(existing)) {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-switchboard`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (next.length) hooks.SessionStart = next;
    else delete hooks.SessionStart;
    config.hooks = hooks;
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  }
  console.log(`${verb === 'install' ? 'registered' : 'removed'} Switchboard SessionStart in ${file}`);
} else throw new Error(`Unknown action: ${verb}`);
