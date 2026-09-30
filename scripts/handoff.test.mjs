import test from 'node:test';
import assert from 'node:assert/strict';
import { canReplaceInPlace } from './handoff.mjs';

test('replace only an identified, wrapped counterpart CLI', () => {
  const exact = { pid: 42, tty: 'ttys001', via: 'pid 42 resumed this thread' };
  assert.equal(canReplaceInPlace('codex', 'claude', exact, true), true);
  assert.equal(canReplaceInPlace('claude', 'codex', exact, true), true);
  assert.equal(canReplaceInPlace('codex', 'claude', exact, false), false);
  assert.equal(canReplaceInPlace('codex', 'claude', { pid: 42, tty: null }, true), false);
  assert.equal(canReplaceInPlace('codex', 'opencode', exact, true), false);
  assert.equal(canReplaceInPlace('codex', 'claude', {
    ...exact, via: 'Codex client with the latest input (pid 42)',
  }, true), false);
});
