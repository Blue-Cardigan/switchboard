import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './state.mjs';

const SURFACES = path.join(ROOT, 'surfaces');

function marker(harness, id) {
  if (!['claude', 'codex'].includes(harness) || !/^[0-9a-f-]{36}$/i.test(id || '')) return null;
  return path.join(SURFACES, `${harness}-${id}.json`);
}

function recorded(harness, id) {
  const file = marker(harness, id);
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).surface || null; }
  catch { return null; }
}

/** Keep the destination chosen for a converted thread, including Codex imports. */
export function rememberSurface(harness, id, surface) {
  const file = marker(harness, id);
  if (!file || !['desktop', 'cli'].includes(surface)) return;
  fs.mkdirSync(SURFACES, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ surface })}\n`);
}

function claudeEntrypoint(id) {
  if (!id) return null;
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    try {
      const row = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (row.sessionId === id) return row.entrypoint === 'claude-desktop' ? 'desktop' : 'cli';
    } catch { /* stale registry entry */ }
  }
  return null;
}

function codexOriginator(file) {
  if (!file) return null;
  try {
    const fd = fs.openSync(file, 'r');
    const bytes = Buffer.alloc(16384);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    fs.closeSync(fd);
    const meta = JSON.parse(bytes.subarray(0, length).toString('utf8').split('\n')[0]);
    const originator = meta.payload?.originator || '';
    if (/desktop/i.test(originator)) return 'desktop';
    if (/codex-tui|codex-cli/i.test(originator)) return 'cli';
  } catch { /* missing or incomplete rollout */ }
  return null;
}

export function sourceSurface(harness, id, file) {
  const override = process.env.SWITCHBOARD_SOURCE_SURFACE;
  if (override === 'desktop' || override === 'cli') return override;
  if (harness === 'claude') return claudeEntrypoint(id) || recorded(harness, id) || 'cli';
  if (harness === 'codex') return recorded(harness, id) || codexOriginator(file) || 'cli';
  return 'cli';
}
