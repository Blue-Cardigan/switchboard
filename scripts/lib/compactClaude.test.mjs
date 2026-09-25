import assert from 'node:assert/strict';
import test from 'node:test';
import { compactClaudeTranscript } from './compactClaude.mjs';

function row(type, content, n) {
  return {
    type, uuid: `row-${n}`, sessionId: 'session', cwd: '/project',
    message: { role: type, content },
  };
}

test('keeps conversational turns and removes tool traffic and quota notices', () => {
  const input = [
    row('user', 'Build the feature', 1),
    row('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'cat secret' } }], 2),
    row('user', [{ type: 'tool_result', content: 'large output' }], 3),
    row('assistant', [{ type: 'text', text: 'Implemented the feature.' }], 4),
    row('assistant', [{ type: 'text', text: "You've hit your session limit · resets 2:50pm" }], 5),
    row('user', '<task-notification>background task stopped</task-notification>', 6),
  ].map((x) => JSON.stringify(x)).join('\n');
  const result = compactClaudeTranscript(Buffer.from(input));
  const rows = result.bytes.toString().trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((x) => x.message.content), [
    'Build the feature', [{ type: 'text', text: 'Implemented the feature.' }],
  ]);
  assert.equal(result.skipped, 4);
  assert.deepEqual(rows.map((x) => x.parentUuid), [null, 'row-1']);
  assert.deepEqual(compactClaudeTranscript(Buffer.from(input)).bytes, result.bytes);
});

test('retains the opening request and newest turns when the budget is exceeded', () => {
  const input = [
    row('user', 'Original request', 1),
    ...Array.from({ length: 8 }, (_, i) => row('assistant', `Reply ${i} with details`, i + 2)),
  ].map((x) => JSON.stringify(x)).join('\n');
  const result = compactClaudeTranscript(Buffer.from(input), { maxChars: 75 });
  const rows = result.bytes.toString().trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].message.content.includes('Original request'), true);
  assert.equal(rows.at(-1).message.content[0].text, 'Reply 7 with details');
  assert.ok(result.dropped > 0);
});
