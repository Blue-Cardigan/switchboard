import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hex = () => crypto.randomBytes(6).toString('hex');
const prefixed = (text, prefix) => String(text ?? '').split('\n').map((line) => prefix + line).join('\n');

/** Native Codex turns, including both model history and projected UI items. */
export function entriesToRolloutRows(entries, { threadId, cwd, startOrdinal, now = Date.now(), header = null }) {
  const turns = [];
  for (const entry of entries) {
    if (entry.role === 'user') turns.push({ user: entry.text, assistant: [] });
    else {
      if (!turns.length) turns.push({ user: '', assistant: [] });
      turns.at(-1).assistant.push(entry);
    }
  }
  if (header && turns.length) turns[0].user = turns[0].user ? `${header}\n\n${turns[0].user}` : header;
  const rows = [];
  const timestamp = new Date(now).toISOString();
  const seconds = Math.floor(now / 1000);
  // Files written before Codex numbered its rows carry no ordinal; match the file.
  const emit = (type, payload) => rows.push(startOrdinal == null
    ? { timestamp, type, payload }
    : { timestamp, ordinal: startOrdinal++, type, payload });
  const event = (payload) => emit('event_msg', payload);
  const response = (payload) => emit('response_item', payload);
  for (const turn of turns) {
    const turnId = `sb-claude-${hex()}`;
    const completed = (item) => event({ type: 'item_completed', thread_id: threadId, turn_id: turnId,
      started_at_ms: now, completed_at_ms: now, item });
    event({ type: 'task_started', turn_id: turnId, root_turn_id: turnId, started_at: seconds,
      model_context_window: null, collaboration_mode_kind: 'default' });
    event({ type: 'user_message', message: turn.user, local_images: [], local_audio: [], text_elements: [] });
    completed({ type: 'UserMessage', id: crypto.randomUUID(), content: [{ type: 'text', text: turn.user }] });
    response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: turn.user }] });
    const prose = [];
    const agent = (text) => {
      const payload = { type: 'agent_message', message: text, phase: 'commentary', memory_citation: null };
      const item = { type: 'AgentMessage', id: `msg_sb_${hex()}`, content: [{ type: 'Text', text }], phase: 'commentary' };
      event(payload);
      completed(item);
      response({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      prose.push({ payload, item, text });
    };
    const command = (cmd, output, isError, parsed) => {
      const callId = `sb-call-${hex()}`;
      response({ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }), call_id: callId });
      response({ type: 'function_call_output', call_id: callId, output });
      completed({ type: 'CommandExecution', id: `sb-exec-${hex()}`, command: ['/bin/zsh', '-lc', cmd], cwd: `file://${cwd}`,
        parsed_cmd: parsed || [{ type: 'unknown', cmd }], source: 'agent', status: isError ? 'failed' : 'completed',
        stdout: output, stderr: '', aggregated_output: output, exit_code: isError ? 1 : 0,
        duration: { secs: 0, nanos: 0 }, formatted_output: output });
    };
    const edit = (file, old, next, add, isError) => {
      const body = add ? prefixed(next, '+') : `${prefixed(old, '-')}\n${prefixed(next, '+')}`;
      const diff = `@@\n${body}\n`;
      const patch = `*** Begin Patch\n*** ${add ? 'Add' : 'Update'} File: ${file}\n${add ? '' : '@@\n'}${body}\n*** End Patch`;
      const callId = `sb-call-${hex()}`;
      response({ type: 'custom_tool_call', name: 'apply_patch', call_id: callId, status: 'completed', input: patch });
      response({ type: 'custom_tool_call_output', call_id: callId, output: isError ? 'Failed' : 'Done' });
      completed({ type: 'FileChange', id: `sb-fc-${hex()}`, changes: {
        [file]: add ? { type: 'add', content: next } : { type: 'update', unified_diff: diff },
      }, status: isError ? 'failed' : 'completed' });
    };
    for (const entry of turn.assistant) {
      if (!entry.tools) { agent(entry.text); continue; }
      for (const tool of entry.tools) {
        const input = tool.input || {};
        const output = String(tool.result ?? 'No output recorded.');
        if (tool.name === 'Bash') command(input.command, output, tool.isError);
        else if (tool.name === 'Read') {
          const cmd = `cat ${input.file_path}`;
          command(cmd, output.slice(0, 400), tool.isError, [{ type: 'read', cmd, name: path.basename(input.file_path), path: input.file_path }]);
        } else if (tool.name === 'Grep') {
          const cmd = `rg ${JSON.stringify(input.pattern)} ${input.path || '.'}`;
          command(cmd, output, tool.isError, [{ type: 'search', cmd, query: input.pattern, path: input.path || null }]);
        } else if (tool.name === 'Glob') {
          const cmd = `rg --files -g ${JSON.stringify(input.pattern)}`;
          command(cmd, output, tool.isError, [{ type: 'list_files', cmd, path: input.path || null }]);
        } else if (tool.name === 'Edit') edit(input.file_path, input.old_string, input.new_string, false, tool.isError);
        else if (tool.name === 'MultiEdit') {
          for (const change of input.edits || []) edit(input.file_path, change.old_string, change.new_string, false, tool.isError);
        } else if (tool.name === 'Write') edit(input.file_path, '', input.content, true, tool.isError);
        else {
          const short = ['description', 'prompt', 'query', 'url', 'plan', 'skill'].map((key) => input[key]).find((value) => typeof value === 'string' && value)
            || JSON.stringify(input);
          agent(`[Claude used ${tool.name}] ${short.slice(0, 200)}\n→ ${output.slice(0, 300)}`);
        }
      }
    }
    if (prose.length) {
      prose.at(-1).payload.phase = 'final_answer';
      prose.at(-1).item.phase = 'final_answer';
    }
    event({ type: 'task_complete', turn_id: turnId, last_agent_message: prose.at(-1)?.text ?? null, started_at: seconds });
  }
  return rows;
}

/** Rollout ordinals are per-file; only the tail is needed to continue them. Null when the file has none. */
export function nextOrdinal(rolloutFile) {
  const fd = fs.openSync(rolloutFile, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 4 * 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start) {
      const previous = Buffer.alloc(1);
      fs.readSync(fd, previous, 0, 1, start - 1);
      if (previous[0] !== 10) lines.shift();
    }
    let max = -1;
    for (const line of lines) {
      try {
        const { ordinal } = JSON.parse(line);
        if (Number.isInteger(ordinal)) max = Math.max(max, ordinal);
      } catch { /* Partial row. */ }
    }
    // null: an unnumbered (older) rollout, whose appended rows must stay unnumbered.
    return max < 0 ? (size ? null : 0) : max + 1;
  } finally { fs.closeSync(fd); }
}
