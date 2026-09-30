import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexTurnHitLimit, pickTarget } from './on-limit.mjs';

function rollout(...payloads) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-limit-')), 'rollout.jsonl');
  fs.writeFileSync(file, payloads.map((payload) => JSON.stringify({ type: 'event_msg', payload })).join('\n'));
  return file;
}

const limited = {
  type: 'task_complete',
  error: { message: "You've hit your usage limit.", codex_error_info: 'usage_limit_exceeded' },
};

test('a Codex turn that ended on the usage limit is detected', () => {
  assert.equal(codexTurnHitLimit(rollout({ type: 'task_complete' }, limited)), true);
});

test('only the last turn counts: a later successful turn clears it', () => {
  assert.equal(codexTurnHitLimit(rollout(limited, { type: 'task_complete', last_agent_message: 'done' })), false);
});

test('other errors and missing files are not a limit', () => {
  assert.equal(codexTurnHitLimit(rollout({ type: 'task_complete', error: { codex_error_info: 'server_error' } })), false);
  assert.equal(codexTurnHitLimit('/nonexistent/rollout.jsonl'), false);
});

test('counterpart target works in both directions', async () => {
  assert.equal(await pickTarget('claude', process.cwd(), 'counterpart'), 'codex');
  assert.equal(await pickTarget('codex', process.cwd(), 'counterpart'), 'claude');
});
