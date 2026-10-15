import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-merge-to-codex-'));
process.env.HOME = home;
process.env.CODEX_HOME = path.join(home, '.codex');
const { claudeEntries } = await import('./claudeToEntries.mjs');
const { entriesToRolloutRows, nextOrdinal } = await import('./codexWriter.mjs');
const { codexHome, mergeToCodex, saveExported } = await import('./mergeToCodex.mjs');
const { rolloutEntries } = await import('./codexToClaude.mjs');

const root = path.join(home, '.claude', 'switchboard');
const cwd = '/work/forest';
const epoch = Date.parse('2026-10-15T12:00:00Z');
const stamp = (n) => new Date(epoch + n * 1000).toISOString();
const text = (value) => ({ type: 'text', text: value });
const toolUse = (id, name = 'Bash', input = { command: 'pwd' }) => ({ type: 'tool_use', id, name, input });
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const readRows = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const state = (file, value) => {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, file), JSON.stringify(value));
};
function chain(specs) {
  return specs.map((spec, i) => {
    const { content, ...rest } = spec;
    return { uuid: `r${i}`, parentUuid: i ? `r${i - 1}` : null, timestamp: stamp(i), type: 'user',
      message: { content }, ...rest };
  });
}
let serial = 0;
function fixture(rows = chain([{ content: 'Question' }, { type: 'assistant', content: [text('Answer')] }] )) {
  const suffix = String(++serial).padStart(12, '0');
  const sessionId = `11111111-2222-4333-8444-${suffix}`;
  const threadId = `01a13c04-094a-7de1-b87e-${suffix}`;
  const transcript = path.join(home, '.claude', 'projects', '-work-forest', `${sessionId}.jsonl`);
  const rollout = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '15', `rollout-2026-10-15T12-00-00-${threadId}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(transcript, jsonl(rows));
  fs.writeFileSync(rollout, jsonl([{ ordinal: 12, type: 'session_meta', payload: { id: threadId, cwd } }]));
  return { transcript, rollout, threadId, sessionId };
}
function exported(f, lastUuid = null) {
  saveExported(f.transcript, { threadId: f.threadId, rollout: f.rollout, lastUuid, at: epoch });
}
function fakeServers(f, { error = null, projection = true, name = null } = {}) {
  const instances = [];
  const factory = (dir) => {
    const app = {
      dir, calls: [], stopped: false,
      start() { this.started = true; },
      notify(method) { this.calls.push([method]); },
      async request(method, params) {
        this.calls.push([method, params]);
        if (method === 'thread/resume') {
          if (error) throw new Error(error);
          return { thread: { id: f.threadId, name } };
        }
        if (method === 'thread/turns/list') {
          const last = readRows(f.rollout).findLast((row) => row.payload?.type === 'task_complete');
          return { data: [{ id: projection ? last?.payload.turn_id : 'old-turn' }] };
        }
        return {};
      },
      stop() { this.stopped = true; },
    };
    if (instances.length) assert.equal(instances.at(-1).stopped, true, 'previous writer stopped before next server');
    instances.push(app);
    return app;
  };
  return { factory, instances };
}

test('Claude reader follows only the main chain, skips imported timestamps, groups and pairs tools, and returns title', () => {
  const rows = chain([
    { content: 'Old question' },
    { type: 'assistant', content: [text('Old reply')] },
    { content: 'Imported question', timestamp: stamp(20) },
    { type: 'assistant', requestId: 'req_codex_import', content: [text('Imported reply')], timestamp: stamp(20) },
    { content: 'Imported trailing row', timestamp: stamp(20) },
    { content: [text('New question'), text('Second line')] },
    { type: 'assistant', content: [toolUse('bash'), { type: 'thinking', thinking: 'private' }, toolUse('read', 'Read', { file_path: '/tmp/x' })] },
    { type: 'assistant', content: [toolUse('grep', 'Grep', { pattern: 'needle' })] },
    { content: [
      { type: 'tool_result', tool_use_id: 'bash', content: 'Failed command', is_error: true },
      { type: 'tool_result', tool_use_id: 'read', content: [text('part one'), text('part two')] },
      { type: 'tool_result', tool_use_id: 'grep', content: 'x'.repeat(3000) },
    ] },
    { type: 'assistant', content: [text('New answer')] },
  ]);
  rows.splice(9, 0, { type: 'assistant', uuid: 'abandoned', parentUuid: 'r1', message: { content: [text('Abandoned branch')] } });
  rows.push(
    { uuid: 'side', parentUuid: 'r9', type: 'assistant', isSidechain: true, message: { content: [text('Sidechain')] } },
    { type: 'custom-title', customTitle: 'Old title' }, { type: 'custom-title', customTitle: 'Latest title' },
  );
  const f = fixture(rows);
  const all = claudeEntries(f.transcript);
  assert.deepEqual(all.entries.filter((e) => e.text).map((e) => e.text), ['Old question', 'Old reply', 'New question\nSecond line', 'New answer']);
  const parsed = claudeEntries(f.transcript, { afterUuid: 'r4' });
  assert.equal(parsed.lastUuid, 'r9');
  assert.equal(parsed.title, 'Latest title');
  assert.equal(parsed.entries.length, 3);
  assert.deepEqual(parsed.entries[1].tools.map((t) => t.id), ['bash', 'read', 'grep']);
  assert.equal(parsed.entries[1].tools[0].result, 'Failed command');
  assert.equal(parsed.entries[1].tools[0].isError, true);
  assert.equal(parsed.entries[1].tools[1].result, 'part one\npart two');
  assert.equal(parsed.entries[1].tools[2].result.length, 2000);
  assert.deepEqual(claudeEntries(f.transcript, { afterUuid: 'r9' }).entries, []);
  assert.equal(claudeEntries(f.transcript, { afterUuid: 'r9' }).lastUuid, 'r9');
});

test('Claude reader recognises every switchboard marker and filters command/meta rows', () => {
  const specs = [];
  for (const [i, marker] of ['[Continued in Codex]', '[Imported from Codex]', '[More turns from Codex, thread abcd]'].entries()) {
    specs.push({ content: marker, timestamp: stamp(30 + i) },
      { type: 'assistant', content: [text('Do not echo')], timestamp: stamp(30 + i) });
  }
  for (const content of ['<command-name>x', '<local-command-stdout>x', '<system-reminder>x']) specs.push({ content });
  specs.push({ content: 'meta', isMeta: true }, { content: '<task-notification>' + 'x'.repeat(2000) },
    { type: 'assistant', content: [toolUse('missing')] });
  const f = fixture(chain(specs));
  const { entries } = claudeEntries(f.transcript);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text.length, 1500);
  assert.equal(entries[1].tools[0].result, 'No output recorded.');
});

test('Claude reader uses timestamp fallback only when UUID cursor is absent or missing', () => {
  const f = fixture();
  assert.deepEqual(claudeEntries(f.transcript, { afterUuid: 'missing', afterMs: epoch }).entries, [{ role: 'assistant', text: 'Answer' }]);
  assert.equal(claudeEntries(f.transcript, { afterUuid: 'r0', afterMs: epoch + 100000 }).entries.length, 1);
  assert.equal(claudeEntries(f.transcript, { afterMs: epoch + 1000 }).lastUuid, 'r1');
  assert.deepEqual(claudeEntries(f.transcript, { afterMs: epoch + 1000 }).entries, []);
});

test('Codex writer emits native rows in order with continuous ordinals, edits, read commands and final prose', () => {
  const entries = [
    { role: 'user', text: 'Question' }, { role: 'assistant', text: 'Working' },
    { role: 'assistant', tools: [
      { name: 'Bash', input: { command: 'pwd' }, result: '/work/forest', isError: false },
      { name: 'Edit', input: { file_path: '/tmp/x', old_string: 'old\nline', new_string: 'new\nline' } },
      { name: 'Read', input: { file_path: '/tmp/x' }, result: 'r'.repeat(600) },
    ] }, { role: 'assistant', text: 'Done' },
  ];
  const rows = entriesToRolloutRows(entries, { threadId: 'thread', cwd, startOrdinal: 37, now: epoch, header: 'Header' });
  assert.deepEqual(rows.map((r) => r.ordinal), Array.from({ length: rows.length }, (_, i) => 37 + i));
  assert.ok(rows.every((r) => r.timestamp === stamp(0)));
  assert.deepEqual(rows.map((r) => [r.type, r.payload.type]), [
    ['event_msg', 'task_started'], ['event_msg', 'user_message'], ['event_msg', 'item_completed'], ['response_item', 'message'],
    ['event_msg', 'agent_message'], ['event_msg', 'item_completed'], ['response_item', 'message'],
    ['response_item', 'function_call'], ['response_item', 'function_call_output'], ['event_msg', 'item_completed'],
    ['response_item', 'custom_tool_call'], ['response_item', 'custom_tool_call_output'], ['event_msg', 'item_completed'],
    ['response_item', 'function_call'], ['response_item', 'function_call_output'], ['event_msg', 'item_completed'],
    ['event_msg', 'agent_message'], ['event_msg', 'item_completed'], ['response_item', 'message'], ['event_msg', 'task_complete'],
  ]);
  assert.match(rows[0].payload.turn_id, /^sb-claude-[a-f0-9]{12}$/);
  assert.equal(rows.at(-1).payload.turn_id, rows[0].payload.turn_id);
  assert.equal(rows[1].payload.message, 'Header\n\nQuestion');
  assert.equal(rows[3].payload.content[0].text, 'Header\n\nQuestion');
  assert.equal(rows[4].payload.phase, 'commentary');
  assert.equal(rows[16].payload.phase, 'final_answer');
  assert.equal(rows[17].payload.item.phase, 'final_answer');
  assert.equal(rows.at(-1).payload.last_agent_message, 'Done');
  assert.ok(rows.filter((r) => r.payload.type === 'item_completed').every((r) => r.payload.started_at_ms === epoch && r.payload.completed_at_ms === epoch));
  assert.equal(rows[8].payload.output, '/work/forest');
  assert.equal(rows[9].payload.item.cwd, 'file:///work/forest');
  assert.deepEqual(rows[12].payload.item.changes['/tmp/x'], { type: 'update', unified_diff: '@@\n-old\n-line\n+new\n+line\n' });
  assert.equal(rows[10].payload.name, 'apply_patch');
  assert.equal(rows[10].payload.input, '*** Begin Patch\n*** Update File: /tmp/x\n@@\n-old\n-line\n+new\n+line\n*** End Patch');
  assert.equal(rows[10].payload.call_id, rows[11].payload.call_id);
  assert.deepEqual(rows[15].payload.item.parsed_cmd, [{ type: 'read', cmd: 'cat /tmp/x', name: 'x', path: '/tmp/x' }]);
  assert.equal(rows[15].payload.item.stdout.length, 400);
});

test('Codex writer groups turns and maps remaining tool kinds and errors', () => {
  const rows = entriesToRolloutRows([
    { role: 'assistant', tools: [
      { name: 'Grep', input: { pattern: 'a b' }, result: 'none', isError: true },
      { name: 'Glob', input: { pattern: '*.mjs', path: '/work' }, result: 'files' },
      { name: 'Write', input: { file_path: '/tmp/new', content: 'new\nfile' } },
      { name: 'MultiEdit', input: { file_path: '/tmp/x', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] } },
      { name: 'Agent', input: { description: 'Research', prompt: 'Long prompt' }, result: 'Findings' },
    ] }, { role: 'user', text: 'Continue' }, { role: 'assistant', text: 'Next turn' },
  ], { threadId: 'thread', cwd, startOrdinal: 0, header: 'Header' });
  const starts = rows.filter((r) => r.payload.type === 'task_started');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].payload.turn_id, starts[1].payload.turn_id);
  assert.deepEqual(rows.filter((r) => r.payload.type === 'user_message').map((r) => r.payload.message), ['Header', 'Continue']);
  const items = rows.filter((r) => r.payload.type === 'item_completed').map((r) => r.payload.item);
  const commands = items.filter((i) => i.type === 'CommandExecution');
  assert.equal(commands[0].status, 'failed');
  assert.equal(commands[0].exit_code, 1);
  assert.deepEqual(commands[0].parsed_cmd, [{ type: 'search', cmd: 'rg "a b" .', query: 'a b', path: null }]);
  assert.deepEqual(commands[1].parsed_cmd, [{ type: 'list_files', cmd: 'rg --files -g "*.mjs"', path: '/work' }]);
  const files = items.filter((i) => i.type === 'FileChange');
  assert.equal(files.length, 3);
  assert.deepEqual(files[0].changes['/tmp/new'], { type: 'add', content: 'new\nfile' });
  assert.ok(rows.some((r) => r.payload.input === '*** Begin Patch\n*** Add File: /tmp/new\n+new\n+file\n*** End Patch'));
  assert.match(rows.find((r) => r.payload.type === 'agent_message').payload.message, /^\[Claude used Agent\] Research\n→ Findings$/);
});

test('nextOrdinal reads the highest existing ordinal and tolerates partial rows', () => {
  const f = fixture();
  fs.appendFileSync(f.rollout, jsonl([{ ordinal: 41 }, { ordinal: 20 }]) + '{"ordinal":');
  assert.equal(nextOrdinal(f.rollout), 42);
  // An older rollout with no numbered rows stays unnumbered; an empty one starts at 0.
  fs.writeFileSync(f.rollout, jsonl([{ type: 'session_meta' }]));
  assert.equal(nextOrdinal(f.rollout), null);
  fs.writeFileSync(f.rollout, '');
  assert.equal(nextOrdinal(f.rollout), 0);
});

test('entriesToRolloutRows leaves rows unnumbered for an unnumbered rollout', () => {
  const rows = entriesToRolloutRows([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }],
    { threadId: 't', cwd: '/w', startOrdinal: null });
  assert.ok(rows.length && rows.every((r) => !('ordinal' in r)));
});

test('codexHome prefers exported cursors, then merged records, then the newest canonical import ledger', () => {
  const f = fixture();
  state('merged.json', { [f.rollout]: { transcript: f.transcript, threadId: f.threadId } });
  assert.deepEqual(codexHome(f.transcript), { threadId: f.threadId, rollout: f.rollout, afterUuid: null, afterMs: null, afterSwitchboard: true });
  exported(f, 'r0');
  assert.deepEqual(codexHome(f.transcript), { threadId: f.threadId, rollout: f.rollout, afterUuid: 'r0' });
  const ledger = fixture();
  const source = fs.realpathSync(ledger.transcript);
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'external_agent_session_imports.json'), JSON.stringify({ records: [
    { source_path: source, imported_thread_id: ledger.threadId, imported_at: epoch / 1000 },
  ] }));
  assert.deepEqual(codexHome(ledger.transcript), { threadId: ledger.threadId, rollout: ledger.rollout, afterMs: epoch });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'claude-cowork-import-history.json'), JSON.stringify({ records: [
    { sourcePath: source, importedThreadId: ledger.threadId, importedAtMs: epoch + 5000 },
  ] }));
  assert.equal(codexHome(ledger.transcript).afterMs, epoch + 5000);
  assert.equal(codexHome(fixture().transcript), null);
});

test('rolloutEntries skips whole Claude-written turns and resumes with native Codex turns', () => {
  const f = fixture();
  const echo = entriesToRolloutRows([{ role: 'user', text: 'Echo user' }, { role: 'assistant', text: 'Echo assistant' }],
    { threadId: f.threadId, cwd, startOrdinal: 13 });
  const native = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'native' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Native user' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Native answer' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'native' } },
  ];
  fs.appendFileSync(f.rollout, jsonl([...echo, ...native, ...echo]));
  assert.deepEqual(rolloutEntries(f.rollout).entries, [{ role: 'user', text: 'Native user' }, { role: 'assistant', text: 'Native answer' }]);
  assert.equal(rolloutEntries(f.rollout).cursor, fs.statSync(f.rollout).size);
});

test('merge refuses busy Claude and active Codex writers without appending or advancing the cursor', async () => {
  const f = fixture();
  exported(f, 'r0');
  const before = fs.readFileSync(f.rollout, 'utf8');
  const fake = fakeServers(f, { error: 'Thread already has an active writer' });
  const sessionDir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  const registration = path.join(sessionDir, `${process.pid}.json`);
  fs.writeFileSync(registration, JSON.stringify({ pid: process.pid, sessionId: f.sessionId, status: 'working' }));
  try {
    assert.equal((await mergeToCodex(f.transcript, { apply: true, server: fake.factory })).status, 'claude-busy');
    assert.equal(fake.instances.length, 0);
  } finally { fs.rmSync(registration); }
  assert.equal((await mergeToCodex(f.transcript, { apply: true, server: fake.factory })).status, 'codex-open');
  assert.equal(fake.instances[0].stopped, true);
  assert.equal(fs.readFileSync(f.rollout, 'utf8'), before);
  assert.equal(codexHome(f.transcript).afterUuid, 'r0');
  const broken = fakeServers(f, { error: 'resume unavailable' });
  assert.deepEqual(await mergeToCodex(f.transcript, { apply: true, server: broken.factory }),
    { threadId: f.threadId, status: 'error', error: 'resume unavailable' });
});

test('merge dry-run does not start a server; success backs up, projects, names and saves its cursor', async () => {
  const f = fixture([...chain([{ content: 'Question' }, { type: 'assistant', content: [text('Answer')] }]),
    { type: 'custom-title', customTitle: 'Claude title' }]);
  exported(f);
  const fake = fakeServers(f);
  const before = fs.readFileSync(f.rollout, 'utf8');
  assert.deepEqual(await mergeToCodex(f.transcript, { server: fake.factory }), { threadId: f.threadId, turns: 2, dropped: 0, status: 'ready' });
  assert.equal(fake.instances.length, 0);
  const result = await mergeToCodex(f.transcript, { apply: true, server: fake.factory });
  assert.equal(result.status, 'merged');
  assert.equal(fs.readFileSync(result.backup, 'utf8'), before);
  assert.equal(fake.instances.length, 2);
  assert.ok(fake.instances.every((app) => app.stopped && app.dir === cwd));
  assert.deepEqual(fake.instances[1].calls.map(([method]) => method), ['initialize', 'initialized', 'thread/resume', 'thread/name/set', 'thread/turns/list']);
  assert.deepEqual(fake.instances[1].calls[3][1], { threadId: f.threadId, name: 'Claude title' });
  assert.equal(codexHome(f.transcript).afterUuid, 'r1');
  const appended = readRows(f.rollout).slice(1);
  assert.equal(appended[0].ordinal, 13);
  assert.match(appended[1].payload.message, /^\[Continued in Claude Code\]/);
  assert.match(appended[1].payload.message, /Question$/);
  assert.deepEqual(rolloutEntries(f.rollout).entries, []);
  assert.equal((await mergeToCodex(f.transcript, { apply: true, server: fake.factory })).status, 'up-to-date');
  assert.equal(fake.instances.length, 2);
});

test('merge starts after the last switchboard block, permits idle Claude, and preserves an existing name', async () => {
  const rows = chain([
    { content: 'Already in Codex' },
    { content: '[Continued in Codex]', timestamp: stamp(50) },
    { type: 'assistant', requestId: 'req_codex_import', content: [text('Codex reply')], timestamp: stamp(50) },
    { content: 'Imported trailing row', timestamp: stamp(50) },
    { content: 'New Claude question' },
    { type: 'assistant', content: [text('New Claude answer')] },
  ]);
  const f = fixture([...rows, { type: 'custom-title', customTitle: 'Do not replace' }]);
  state('merged.json', { [f.rollout]: { transcript: f.transcript, threadId: f.threadId } });
  const registration = path.join(home, '.claude', 'sessions', `${process.pid}.json`);
  fs.writeFileSync(registration, JSON.stringify({ pid: process.pid, sessionId: f.sessionId, status: 'idle' }));
  const fake = fakeServers(f, { name: 'Existing name' });
  try {
    const r = await mergeToCodex(f.transcript, { apply: true, server: fake.factory });
    assert.equal(r.status, 'merged');
    assert.equal(r.turns, 2);
  } finally { fs.rmSync(registration); }
  const appended = readRows(f.rollout).slice(1);
  assert.match(appended[1].payload.message, /New Claude question$/);
  assert.doesNotMatch(JSON.stringify(appended), /Already in Codex|Imported trailing row|Codex reply/);
  assert.ok(!fake.instances[1].calls.some(([method]) => method === 'thread/name/set'));
});

test('failed projection restores the rollout and leaves the export cursor unchanged', async () => {
  const f = fixture();
  exported(f, 'r0');
  const before = fs.readFileSync(f.rollout, 'utf8');
  const fake = fakeServers(f, { projection: false });
  assert.deepEqual(await mergeToCodex(f.transcript, { apply: true, server: fake.factory }),
    { threadId: f.threadId, status: 'error', error: 'projection failed' });
  assert.equal(fs.readFileSync(f.rollout, 'utf8'), before);
  assert.equal(codexHome(f.transcript).afterUuid, 'r0');
  assert.ok(fake.instances.every((app) => app.stopped));
});

test('no-home and empty merges need no server, and applying an empty merge records the last chain UUID', async () => {
  const f = fixture();
  assert.deepEqual(await mergeToCodex(f.transcript), { status: 'no-home' });
  const empty = fixture(chain([{ content: '[Imported from Codex]', timestamp: stamp(100) },
    { type: 'assistant', requestId: 'req_codex_import', content: [text('Imported')], timestamp: stamp(100) }]));
  state('merged.json', { [empty.rollout]: { transcript: empty.transcript, threadId: empty.threadId } });
  const fake = fakeServers(empty);
  assert.equal((await mergeToCodex(empty.transcript, { apply: true, server: fake.factory })).status, 'up-to-date');
  assert.equal(fake.instances.length, 0);
  assert.equal(codexHome(empty.transcript).afterUuid, 'r1');
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
