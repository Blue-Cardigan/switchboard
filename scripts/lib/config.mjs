// User preferences that outlive any one directory or session, unlike the
// per-cwd routing state in state.mjs. One small JSON file; every key has a
// default, so a missing or half-written file behaves like a fresh install.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './state.mjs';

export const CONFIG_PATH = path.join(ROOT, 'config.json');

export const DEFAULTS = Object.freeze({
  onLimit: Object.freeze({
    // Hand the conversation on when the harness running it hits its usage limit.
    enabled: true,
    // A harness id, or 'recent' for whichever other installed harness was used
    // most recently in this directory.
    target: 'recent',
    // Open the new session with a prompt telling it to carry on, rather than
    // waiting for you to type.
    start: false,
    prompt: 'The previous agent hit its usage limit partway through this conversation. ' +
      'Pick up where it left off: work out what was in progress and continue it.',
  }),
});

export function load() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch { /* defaults */ }
  return { ...DEFAULTS, ...raw, onLimit: { ...DEFAULTS.onLimit, ...(raw.onLimit || {}) } };
}

export function save(config) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}
