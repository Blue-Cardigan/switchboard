import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRows } from './claudeTranscript.mjs';

test('tool results are never empty: the API rejects an empty error result', () => {
  const base = { sessionId: 's', cwd: '/w' };
  const rows = buildRows([
    { role: 'user', text: 'go' },
    { role: 'assistant', tools: [
      { id: 'a', name: 'Bash', input: { command: 'false' }, result: '', isError: true },
      { id: 'b', name: 'Bash', input: { command: 'true' }, result: '  ', isError: false },
      { id: 'c', name: 'Bash', input: { command: 'echo x' }, result: 'x', isError: false },
    ] },
  ], { base });
  const results = rows.at(-1).message.content;
  assert.deepEqual(results.map((r) => r.content), ['Failed with no output.', 'No output.', 'x']);
  assert.deepEqual(results.map((r) => r.is_error), [true, false, false]);
});
