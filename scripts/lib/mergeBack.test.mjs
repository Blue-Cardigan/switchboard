import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every path the merge touches hangs off HOME, so a scratch HOME isolates it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-merge-'));
process.env.HOME = home;
process.env.CODEX_HOME = path.join(home, '.codex');
const { mergeSession, importBoundary, codexTurnState, fitTurns, appendToTranscript } = await import('./mergeBack.mjs');

const cwd = '/work/forest';
const claudeId = '11111111-2222-4333-8444-555555555555';
const threadId = '01a13c04-094a-7de1-b87e-24cd91481aeb';
const transcript = path.join(home, '.claude', 'projects', '-work-forest', `${claudeId}.jsonl`);
const rollout = path.join(home, '.codex', 'sessions', '2026', '10', '14', `rollout-2026-10-14T21-04-19-${threadId}.jsonl`);

const line = (type, payload) => `${JSON.stringify({ timestamp: '2026-10-14T20:00:00Z', type, payload })}\n`;
const turn = (id, user, reply) =>
  line('event_msg', { type: 'task_started', turn_id: id })
  + line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] })
  + line('response_item', { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.exec_command({cmd:"git status"}));' })
  + line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] })
  + line('event_msg', { type: 'task_complete', turn_id: id });

function setup() {
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  const base = { isSidechain: false, userType: 'external', entrypoint: 'claude-desktop', cwd, sessionId: claudeId, version: '2.1.295', gitBranch: 'main' };
  fs.writeFileSync(transcript, [
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Start in Claude' } },
    { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'Claude reply' }] } },
    { type: 'last-prompt', sessionId: claudeId },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(rollout,
    line('session_meta', { id: threadId, session_id: threadId, cwd })
    + turn('external-import-turn-1', 'Start in Claude', 'Claude reply')
    + line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work/forest\n<INSTRUCTIONS>' }] })
    + turn('01a13c29-b56a', '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>\n\nNow in Codex', 'Codex reply one'));
  fs.writeFileSync(path.join(home, '.codex', 'external_agent_session_imports.json'), JSON.stringify({
    records: [{ source_path: transcript, imported_thread_id: threadId, imported_at: 1791982138 }],
  }));
}

const session = () => ({ file: rollout, sessionId: threadId, threadId, cwd });
const rows = () => fs.readFileSync(transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('appends only Codex-native turns, chained to the Claude leaf, scaffolding stripped', () => {
  setup();
  assert.equal(importBoundary(rollout).imported, true);
  const result = mergeSession(session(), { apply: true });
  assert.equal(result.status, 'merged');

  const all = rows();
  const added = all.slice(3);
  assert.equal(added[0].parentUuid, 'a1');
  assert.deepEqual(added.map((r) => r.type), ['user', 'assistant', 'user', 'assistant']);
  assert.match(added[0].message.content, /^\[Continued in Codex\]/);
  assert.match(added[0].message.content, /Now in Codex$/);
  assert.doesNotMatch(added[0].message.content, /AGENTS\.md|external_codex_apps|Start in Claude/);
  assert.equal(added[1].message.content[0].type, 'tool_use');
  assert.equal(added[1].message.content[0].name, 'Bash');
  assert.equal(added[1].message.content[0].input.command, 'git status');
  assert.equal(added[2].message.content[0].tool_use_id, added[1].message.content[0].id);
  assert.equal(added[3].message.content[0].text, 'Codex reply one');
  assert.ok(added.every((r) => r.sessionId === claudeId && r.cwd === cwd));
  assert.ok(fs.existsSync(result.backup));
});

test('a second merge appends only what Codex added since', () => {
  assert.equal(mergeSession(session(), { apply: true }).status, 'up-to-date');
  fs.appendFileSync(rollout, turn('01a13c30-0000', 'Carry on', 'Codex reply two'));
  const before = rows().length;
  assert.equal(mergeSession(session(), { apply: true }).status, 'merged');
  const added = rows().slice(before);
  assert.equal(added[0].parentUuid, rows()[before - 1].uuid);
  assert.match(added[0].message.content, /^\[More turns from Codex/);
  assert.match(added[0].message.content, /Carry on$/);
  assert.doesNotMatch(JSON.stringify(added), /Codex reply one/);
});

test('refuses while Codex is mid-turn', () => {
  fs.appendFileSync(rollout, line('event_msg', { type: 'task_started', turn_id: '01a13c31-0000' }));
  assert.equal(codexTurnState(rollout).inFlight, true);
  assert.equal(mergeSession(session(), { apply: true }).status, 'codex-busy');
  fs.appendFileSync(rollout, line('event_msg', { type: 'turn_aborted', turn_id: '01a13c31-0000' }));
  assert.equal(codexTurnState(rollout).inFlight, false);
});

test('fitTurns keeps the opening and the newest tail', () => {
  const turns = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `t${i} ${'x'.repeat(100)}` }));
  const { turns: fitted, dropped } = fitTurns(turns, threadId, 2000);
  assert.ok(dropped > 0);
  assert.equal(fitted[0].text, turns[0].text);
  assert.equal(fitted.at(-1).text, turns.at(-1).text);
  assert.match(fitted[2].text, /omitted for length/);
});

test('appends a title only when the transcript has none and keeps chaining past metadata', () => {
  setup();
  const result = mergeSession({ ...session(), name: 'Imported title' }, { apply: true });
  assert.equal(result.status, 'merged');
  assert.deepEqual(rows().slice(-2), [
    { type: 'custom-title', customTitle: 'Imported title', sessionId: claudeId },
    { type: 'agent-name', agentName: 'Imported title', sessionId: claudeId },
  ]);
  const leaf = rows().at(-3);
  const before = rows().length;
  appendToTranscript(transcript, [{ role: 'assistant', text: 'Continued' }], 'More', { title: 'Replacement' });
  assert.equal(rows()[before].parentUuid, leaf.uuid);
  assert.equal(rows().filter((row) => row.type === 'custom-title').length, 1);
});

test('fitTurns budgets inputs and results without splitting a tool round', () => {
  const round = { role: 'assistant', tools: [
    { id: 'one', name: 'Bash', input: { command: 'x'.repeat(500) }, result: 'y'.repeat(500) },
    { id: 'two', name: 'Read', input: { file_path: '/tmp/x' }, result: 'read' },
  ] };
  const head = [{ role: 'user', text: 'start' }, { role: 'assistant', text: 'reply' }];
  const all = [...head, round, { role: 'user', text: 'latest' }];
  assert.equal(fitTurns(all, threadId, 2000).turns, all);
  // Over budget, tool output is shortened before any conversation is dropped,
  // and the round is shortened as a whole, never split.
  const fitted = fitTurns(all, threadId, 500);
  assert.equal(fitted.dropped, 0);
  assert.deepEqual(fitted.turns.filter((t) => !t.tools).map((t) => t.text), ['start', 'reply', 'latest']);
  const shrunk = fitted.turns.find((t) => t.tools);
  assert.deepEqual(shrunk.tools.map((t) => t.id), ['one', 'two']);
  assert.ok(shrunk.tools[0].result.length < 500 && shrunk.tools[0].input.command.length < 500);
});

test('fitTurns drops older tool rounds before conversation, and the middle only as a last resort', () => {
  const rounds = Array.from({ length: 60 }, (_, i) => ({
    role: 'assistant', tools: [{ id: `t${i}`, name: 'Bash', input: { command: 'c'.repeat(150) }, result: 'r'.repeat(80) }],
  }));
  const prose = [{ role: 'user', text: 'start' }, ...rounds, { role: 'assistant', text: 'done' }];
  const fitted = fitTurns(prose, threadId, 12000);
  assert.equal(fitted.dropped, 0);
  assert.match(fitted.turns.find((t) => !t.tools && /omitted/.test(t.text)).text, /earlier Codex tool call\(s\) omitted/);
  assert.equal(fitted.turns.at(-1).text, 'done');
  assert.equal(fitted.turns[0].text, 'start');
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
