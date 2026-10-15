import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every path the merge touches hangs off HOME, so a scratch HOME isolates it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-merge-'));
process.env.HOME = home;
process.env.CODEX_HOME = path.join(home, '.codex');
const { mergeSession, importBoundary, codexTurnState, fitTurns } = await import('./mergeBack.mjs');

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
  assert.deepEqual(added.map((r) => r.type), ['user', 'assistant']);
  assert.match(added[0].message.content, /^\[Continued in Codex\]/);
  assert.match(added[0].message.content, /Now in Codex$/);
  assert.doesNotMatch(added[0].message.content, /AGENTS\.md|external_codex_apps|Start in Claude/);
  assert.match(added[1].message.content[0].text, /Codex reply one[\s\S]*\$ git status/);
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

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
