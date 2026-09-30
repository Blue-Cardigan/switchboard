import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceSurface } from './surface.mjs';
import { desktopResumeCommand } from './launch.mjs';

test('Codex rollout originator selects its launch surface', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-surface-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = '12345678-1234-1234-1234-123456789abc';
  const file = path.join(dir, 'rollout.jsonl');
  for (const [originator, expected] of [['Codex Desktop', 'desktop'], ['codex-tui', 'cli']]) {
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { originator } })}\n`);
    assert.equal(sourceSurface('codex', id, file), expected);
  }
});

test('desktop launch commands target the corresponding app', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  if (process.platform !== 'darwin') return;
  assert.equal(desktopResumeCommand(id, '/tmp/my project', 'claude'),
    `cd '/tmp/my project' && claude --desktop --resume ${id}`);
  assert.equal(desktopResumeCommand(id, '/tmp/my project', 'codex'),
    `open -a ChatGPT 'codex://threads/${id}'`);
});
