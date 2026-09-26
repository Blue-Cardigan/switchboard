#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './lib/state.mjs';
import { onPath } from './lib/proc.mjs';
import { claudeProcess, resolveSession } from './lib/claudeSession.mjs';

const home = os.homedir();
const root = path.resolve(new URL('..', import.meta.url).pathname);
function report(label, good, detail = '') {
  console.log(`${good ? '✓' : '!'} ${label}${detail ? `: ${detail}` : ''}`);
}
function version(bin) {
  try { return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0]; }
  catch { return 'installed; version unavailable'; }
}
function hasHook() {
  const file = path.join(root, 'hooks', 'hooks.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionStart.some((group) => group.hooks.some((h) => h.command.includes('session-start.mjs'))); }
  catch { return false; }
}

report('Switchboard SessionStart hook', hasHook(), 'declared in plugin hooks');
const settings = path.join(home, '.claude', 'settings.json');
let installed = false;
try { installed = JSON.stringify(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks?.SessionStart || []).includes(`${root}/scripts/session-start.mjs`); } catch { /* absent */ }
report('Claude SessionStart registration', installed, installed ? settings : 'run ./install.sh');
const wrapper = path.join(home, '.config', 'switchboard', 'codex-handoff.zsh');
let wrapperReady = false;
try { wrapperReady = fs.realpathSync(wrapper) === path.join(root, 'shell', 'codex-handoff.zsh'); } catch { /* absent */ }
report('shell wrapper', wrapperReady, wrapper);
for (const name of ['cx', 'cc', 'sb', 'id']) {
  const file = path.join(home, '.local', 'bin', name);
  let linked = false;
  try { linked = fs.realpathSync(file) === path.join(root, 'bin', name); } catch { /* absent */ }
  report(`${name} command`, linked, file);
}
for (const bin of ['claude', 'codex', 'agy', 'gemini', 'opencode', 'goose', 'crush', 'aider', 'qwen']) {
  report(bin, onPath(bin), onPath(bin) ? version(bin) : 'not installed');
}
const proc = claudeProcess();
const current = proc && resolveSession(process.cwd(), proc.tty);
report('current Claude session mapping', !proc || Boolean(current), proc ? (current?.via || 'missing') : 'outside Claude');
const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
for (const name of ['external_agent_session_imports.json', 'claude-cowork-import-history.json']) {
  const file = path.join(codexHome, name);
  report(`Codex ledger ${name}`, fs.existsSync(file), fs.existsSync(file) ? file : 'absent; created by Codex when needed');
}
const pending = path.join(ROOT, 'pending');
let count = 0;
try { count = fs.readdirSync(pending).filter((name) => name.endsWith('.json')).length; } catch { /* empty */ }
report('pending handoffs', true, `${count} staged`);
