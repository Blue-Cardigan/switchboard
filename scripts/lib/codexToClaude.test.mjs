import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tools-'));
process.env.HOME = home;
const { rolloutEntries, entryCounts, rolloutMeta } = await import('./codexToClaude.mjs');
const { buildRows, normalise, writeTranscript, buildPreamble } = await import('./claudeTranscript.mjs');
const file = path.join(home, 'rollout.jsonl');
const base = { sessionId: 'test-session', cwd: '/work/project' };
const line = (type, payload) => JSON.stringify({ timestamp: '2026-10-15T12:00:00Z', type, payload }) + '\n';
const response = (payload) => line('response_item', payload);
const message = (role, text) => response({ type: 'message', role, content: [{ type: 'input_text', text }] });
const exec = (input, call_id = 'exec-1') => response({ type: 'custom_tool_call', name: 'exec', input, call_id });
const output = (texts, call_id = 'exec-1') => response({ type: 'custom_tool_call_output', call_id, output: [
  { type: 'input_text', text: 'Script completed\nWall time 0.5 seconds\nOutput:\n' },
  ...texts.map((text) => ({ type: 'input_text', text })),
] });
const read = (text, options) => { fs.writeFileSync(file, text); return rolloutEntries(file, options); };

test('code-mode calls become one round with paired outputs, patch hunks and native rows', () => {
  const patch = '*** Begin Patch\n*** Update File: /work/project/a.ts\n@@\n-old\n+new\n context\n@@ other\n same\n-before\n+after\n*** Move to: /ignored.ts\n*** Add File: /work/project/b.ts\n+hello\n+world\n*** End Patch';
  const input = `text(await tools.exec_command({cmd:"git status",workdir:"/x",max_output_tokens:6500}));\ntext(await tools.exec_command({"cmd":"npm test"}));\ntext(await tools.apply_patch(${JSON.stringify(patch)}));`;
  const { entries } = read(exec(input) + output([
    JSON.stringify({ output: 'clean', exit_code: 0 }), JSON.stringify({ output: 'test failed', exit_code: 1 }),
  ]));
  assert.equal(entries.length, 1);
  const tools = entries[0].tools;
  assert.deepEqual(tools.map((t) => t.name), ['Bash', 'Bash', 'Edit', 'Edit', 'Write']);
  assert.equal(tools[0].result, 'clean');
  assert.equal(tools[1].result, 'test failed');
  assert.equal(tools[1].isError, true);
  assert.deepEqual(tools[2].input, { file_path: '/work/project/a.ts', old_string: 'old\ncontext', new_string: 'new\ncontext', replace_all: false });
  assert.deepEqual(tools[3].input, { file_path: '/work/project/a.ts', old_string: 'same\nbefore', new_string: 'same\nafter', replace_all: false });
  assert.deepEqual(tools[4].input, { file_path: '/work/project/b.ts', content: 'hello\nworld' });
  assert.equal(tools[2].result, 'Applied in Codex.');
  assert.equal(new Set(tools.map((t) => t.id)).size, 5);
  assert.ok(tools.every((t) => /^toolu_cx_[a-f\d]{24}$/.test(t.id)));
  const rows = buildRows(entries, { base });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].message.stop_reason, 'tool_use');
  assert.equal(rows[1].parentUuid, rows[0].uuid);
  assert.equal(rows[1].message.content.length, 5);
  assert.deepEqual(rows[1].message.content.map((t) => t.tool_use_id), tools.map((t) => t.id));
  assert.equal(rows[1].message.content[1].is_error, true);
  assert.equal('toolUseResult' in rows[1], false);
  assert.equal('model' in rows[0].message, false);
  assert.equal(rows[0].requestId, 'req_codex_import');
});

test('assistant prose precedes tools in one assistant row, with results chained to the next prompt', () => {
  const { entries } = read(message('assistant', 'Checking now') + exec('tools.exec_command({cmd:"pwd"})') + message('user', 'Continue'));
  const rows = buildRows(entries, { base, parentUuid: 'previous' });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].parentUuid, 'previous');
  assert.deepEqual(rows[0].message.content.map((b) => b.type), ['text', 'tool_use']);
  assert.equal(rows[0].message.content[0].text, 'Checking now');
  assert.equal(rows[1].toolUseResult.stdout, 'No output recorded.');
  assert.equal(rows[2].parentUuid, rows[1].uuid);
  assert.equal(rows[2].message.content, 'Continue');
  assert.deepEqual(normalise([{ role: 'assistant', text: 'a' }, { role: 'assistant', text: 'b' }, entries[1], { role: 'assistant', text: 'c' }]).map((e) => e.text || 'tools'), ['a\n\nb', 'tools', 'c']);
});

test('completed command and file events do not duplicate response-item calls', () => {
  const { entries } = read(exec('tools.exec_command({cmd:"git status"})')
    + line('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', command: 'git status' } })
    + line('event_msg', { type: 'item_completed', item: { type: 'FileChange', changes: { '/x': { type: 'add', content: 'x' } } } }));
  assert.equal(entries[0].tools.length, 1);
});

test('questions and collaboration agents retain answers as tool results', () => {
  const { entries } = read(response({ type: 'function_call', name: 'request_user_input', call_id: 'q', arguments: JSON.stringify({ questions: [
    { question: 'Choose', header: 'A very long header', options: [{ label: 'Yes' }, { label: 'No', description: 'Stop' }] },
    { title: 'Explain' },
  ] }) }) + response({ type: 'function_call_output', call_id: 'q', output: 'Yes, because…' })
    + response({ type: 'function_call', name: 'collaboration.spawn_agent', call_id: 'agent', arguments: JSON.stringify({ message: 'Review this code' }) })
    + response({ type: 'function_call_output', call_id: 'agent', output: [{ type: 'input_text', text: 'Spawned' }] }));
  const tools = entries[0].tools;
  assert.deepEqual(tools.map((t) => t.name), ['AskUserQuestion', 'Agent']);
  assert.equal(tools[0].input.questions[0].header.length, 12);
  assert.deepEqual(tools[0].input.questions[0].options, [{ label: 'Yes', description: '' }, { label: 'No', description: 'Stop' }]);
  assert.deepEqual(tools[0].input.questions[1].options.map((o) => o.label), ['Answer', 'Other']);
  assert.equal(buildRows(entries, { base })[1].message.content[0].content, 'Yes, because…');
  assert.equal(tools[1].input.prompt, 'Review this code');
  assert.equal(tools[1].result, 'Spawned');
});

test('rewrites only absolute assistant links inside cwd and strips harness prompts', () => {
  const { entries } = read(message('user', '# AGENTS.md instructions\nIgnore')
    + message('user', '<external_codex_apps_open_page>page</external_codex_apps_open_page>\nPrompt')
    + message('assistant', '[file](/work/project/sub/file.ts:12) [other](/work/project-other/a.ts) [out](/tmp/a) [web](https://example.com)')
    + message('user', '[original](/work/project/a)'), { cwd: '/work/project' });
  assert.equal(entries[0].text, 'Prompt');
  assert.equal(entries[1].text, '[file](sub/file.ts:12) [other](/work/project-other/a.ts) [out](/tmp/a) [web](https://example.com)');
  assert.equal(entries[2].text, '[original](/work/project/a)');
});

test('writes title rows after conversation rows', () => {
  const written = writeTranscript({ cwd: base.cwd, entries: [{ role: 'assistant', text: 'Done' }], title: 'Codex title' });
  const rows = fs.readFileSync(written.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.slice(-2), [
    { type: 'custom-title', customTitle: 'Codex title', sessionId: written.sessionId },
    { type: 'agent-name', agentName: 'Codex title', sessionId: written.sessionId },
  ]);
});

test('maps template patches, web queries and images; skips unmapped calls and quoted code', () => {
  const { entries } = read(exec('const fake=' + JSON.stringify('tools.exec_command({cmd:"fake"})') + ';\n'
    + '// tools.exec_command({cmd:"comment"})\n'
    + 'tools.apply_patch(`*** Begin Patch\n*** Add File: /tmp/new\n+hello\n*** Delete File: /tmp/old\n*** End Patch`);\n'
    + 'text(await tools.web__run({search_query:[{q:"query one"},{q:"two"}],open:[{ref_id:"https://example.com"}],response_length:"short"}));\n'
    + 'const im=await tools.view_image({path:"/tmp/x.png"});\n'
    + 'tools.write_stdin({session_id:93640,chars:""});') + output(['web output']));
  assert.deepEqual(entries[0].tools.map((t) => t.name), ['Write', 'Bash', 'WebSearch', 'WebSearch', 'WebFetch', 'Read']);
  assert.equal(entries[0].tools[0].input.content, 'hello');
  assert.equal(entries[0].tools[1].input.command, 'rm /tmp/old');
  assert.equal(entries[0].tools[2].input.query, 'query one');
  assert.equal(entries[0].tools[4].input.url, 'https://example.com');
  assert.equal(entries[0].tools[4].result, 'web output');
  assert.equal(entries[0].tools[5].result, 'Image viewed in Codex.');
  assert.deepEqual(read(exec('tools.write_stdin({session_id:1,chars:""});')).entries, []);
});

test('older CLI event fallbacks and plans render as tools', () => {
  const { entries } = read(line('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'git status'], aggregatedOutput: 'clean' } })
    + line('event_msg', { type: 'item_completed', item: { type: 'FileChange', changes: {
      '/tmp/a': { unified_diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new' }, '/tmp/b': { type: 'add', content: 'created' },
    } } }) + line('event_msg', { type: 'item_completed', item: { type: 'Plan', text: 'Do the work' } }));
  assert.deepEqual(entries[0].tools.map((t) => t.name), ['Bash', 'Edit', 'Write', 'ExitPlanMode']);
  assert.equal(entries[0].tools[0].result, 'clean');
  assert.equal(entries[0].tools[1].input.old_string, 'old');
  assert.equal(entries[0].tools[3].input.plan, 'Do the work');
});

test('shell function calls, output overflow and truncation are preserved', () => {
  const { entries } = read(response({ type: 'function_call', name: 'shell', call_id: 'shell', arguments: JSON.stringify({ command: ['/bin/zsh', '-lc', 'pwd'] }) })
    + response({ type: 'function_call_output', call_id: 'shell', output: 'x'.repeat(2500) })
    + exec('tools.exec_command({cmd:"one"}); tools.exec_command({cmd:"two"});')
    + output(['first', 'second', JSON.stringify({ output: 'third', exit_code: 2 })]));
  assert.equal(entries[0].tools[0].input.command, 'pwd');
  assert.match(entries[0].tools[0].result, /\n… \[truncated\]$/);
  assert.equal(entries[0].tools[1].result, 'first');
  assert.equal(entries[0].tools[2].result, 'second\nthird');
  assert.equal(entries[0].tools[2].isError, true);
});

test('byte cursors consume only complete lines across chunks, Unicode and truncation', () => {
  const initial = message('user', 'こんにちは');
  const large = message('assistant', 'é'.repeat(600000));
  const partial = message('user', 'Later');
  const first = read(initial + large + partial.slice(0, -5));
  assert.equal(first.cursor, Buffer.byteLength(initial + large));
  assert.equal(first.entries.length, 2);
  fs.appendFileSync(file, partial.slice(-5));
  const next = rolloutEntries(file, { from: first.cursor });
  assert.deepEqual(next.entries, [{ role: 'user', text: 'Later' }]);
  assert.equal(next.cursor, fs.statSync(file).size);
  fs.writeFileSync(file, initial);
  const rotated = rolloutEntries(file, { from: next.cursor });
  assert.equal(rotated.entries[0].text, 'こんにちは');
  assert.equal(rotated.cursor, Buffer.byteLength(initial));
});

test('structured preambles report entries while legacy context wording stays intact', () => {
  const entries = [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'checking' }, { role: 'assistant', tools: [{ name: 'Bash' }, { name: 'Edit' }, { name: 'Read' }] }];
  const counts = entryCounts(entries);
  assert.deepEqual(counts, { user: 1, assistant: 1, commands: 1, fileChanges: 1, tools: 3 });
  assert.match(buildPreamble(base, counts, false), /summarised as \[Codex activity\]/);
  const preamble = buildPreamble(base, counts, false, undefined, { structured: true });
  assert.match(preamble, /recorded output \(outputs may be truncated\)/);
  assert.doesNotMatch(preamble, /\[Codex activity\]/);
  read(line('session_meta', { id: 'thread', cwd: base.cwd }));
  assert.equal(rolloutMeta(file).cwd, base.cwd);
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
