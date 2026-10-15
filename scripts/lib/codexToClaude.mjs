import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { textOf, shellCommand, userText } from './codexRollout.mjs';

const MAX_DELTA = 64 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const clamp = (value) => {
  const text = String(value ?? '');
  return text.length <= 2000 ? text : `${text.slice(0, 2000)}\n… [truncated]`;
};
const tool = (name, input, result = 'No output recorded.') => ({
  id: `toolu_cx_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
  name, input, result, isError: false,
});

// Parse only literal arguments, never execute rollout JavaScript. Bare object keys
// and template strings are the two differences from JSON needed by code-mode.
function literal(source, start) {
  let i = start;
  const space = () => { while (/\s/.test(source[i] || '') && i < source.length) i++; };
  const value = () => {
    space();
    const quote = source[i];
    if (quote === '"' || quote === '`' || quote === "'") {
      const begin = i++;
      let out = '';
      while (i < source.length) {
        const c = source[i++];
        if (c === quote) return quote === '"' ? JSON.parse(source.slice(begin, i)) : out;
        if (c !== '\\') { out += c; continue; }
        const escaped = source[i++];
        if (escaped === 'u') {
          const hex = source.slice(i, i + 4);
          if (!/^[a-f\d]{4}$/i.test(hex)) throw new Error('Invalid escape');
          out += String.fromCharCode(parseInt(hex, 16)); i += 4;
        } else out += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\n': '' })[escaped] ?? escaped;
      }
      throw new Error('Unclosed string');
    }
    if (quote === '{' || quote === '[') {
      const array = quote === '[';
      const out = array ? [] : {};
      const end = array ? ']' : '}';
      i++; space();
      while (source[i] !== end) {
        if (i >= source.length) throw new Error('Unclosed literal');
        if (array) out.push(value());
        else {
          let key;
          if (/['"`]/.test(source[i])) key = value();
          else {
            const match = /^[\w$]+/.exec(source.slice(i));
            if (!match) throw new Error('Invalid key');
            key = match[0]; i += key.length;
          }
          space();
          if (source[i++] !== ':') throw new Error('Expected colon');
          Object.defineProperty(out, key, { value: value(), enumerable: true, configurable: true, writable: true });
        }
        space();
        if (source[i] === ',') { i++; space(); }
        else if (source[i] !== end) throw new Error('Expected comma');
      }
      i++; return out;
    }
    const match = /^(true|false|null|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(source.slice(i));
    if (!match) throw new Error('Not a literal');
    i += match[0].length;
    return JSON.parse(match[0]);
  };
  return { value: value(), end: i };
}

function* calls(source) {
  const pattern = /\btools\.([\w$]+)\s*\(/y;
  for (let i = 0; i < source.length;) {
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i); i = end < 0 ? source.length : end + 1; continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue;
    }
    if (/['"`]/.test(source[i])) {
      try { i = literal(source, i).end; } catch { i++; }
      continue;
    }
    pattern.lastIndex = i;
    const match = pattern.exec(source);
    if (match) {
      try {
        const parsed = literal(source, pattern.lastIndex);
        yield { name: match[1], args: parsed.value };
        i = parsed.end; continue;
      } catch { /* Non-literal calls cannot be reconstructed safely. */ }
    }
    i++;
  }
}

function edits(file, lines, unified = false) {
  const blocks = [];
  let old = null, next = [];
  const flush = () => {
    if (old !== null) blocks.push(tool('Edit', {
      file_path: file, old_string: old.join('\n'), new_string: next.join('\n'), replace_all: false,
    }, 'Applied in Codex.'));
  };
  for (const line of lines) {
    if (line.startsWith('@@')) { flush(); old = []; next = []; }
    else if (old !== null && !(unified && (line.startsWith('---') || line.startsWith('+++')))) {
      if (line.startsWith(' ') || line.startsWith('-')) old.push(line.slice(1));
      if (line.startsWith(' ') || line.startsWith('+')) next.push(line.slice(1));
    }
  }
  flush();
  return blocks;
}

function patchTools(patch) {
  const lines = String(patch).split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(lines[i]);
    if (!match) continue;
    const [, action, file] = match;
    const body = [];
    while (i + 1 < lines.length && !/^\*\*\* (?:Update|Add|Delete) File:|^\*\*\* End Patch/.test(lines[i + 1])) body.push(lines[++i]);
    if (action === 'Update') blocks.push(...edits(file, body.filter((line) => !line.startsWith('*** Move to:'))));
    else if (action === 'Add') blocks.push(tool('Write', {
      file_path: file, content: body.filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n'),
    }, 'Applied in Codex.'));
    else blocks.push(tool('Bash', { command: `rm ${file}`, description: 'Deleted in Codex' }, 'Applied in Codex.'));
  }
  return blocks;
}

function execTools(source) {
  const blocks = [];
  for (const { name, args } of calls(String(source || ''))) {
    if (name === 'exec_command' && typeof args?.cmd === 'string') blocks.push(tool('Bash', { command: args.cmd, description: 'Ran in Codex' }));
    else if (name === 'apply_patch' && typeof args === 'string') blocks.push(...patchTools(args));
    else if (name === 'view_image' && args?.path) blocks.push(tool('Read', { file_path: args.path }, 'Image viewed in Codex.'));
    else if (name === 'web__run') {
      for (const query of args?.search_query || []) if (query.q) blocks.push(tool('WebSearch', { query: query.q }, 'Searched in Codex.'));
      const open = args?.open || (args?.url ? [{ url: args.url }] : []);
      for (const entry of open) {
        const url = typeof entry === 'string' ? entry : entry.url || entry.ref_id;
        if (url) blocks.push(tool('WebFetch', { url, prompt: 'Opened in Codex' }, 'Searched in Codex.'));
      }
    }
  }
  return blocks;
}

function functionTools(payload) {
  let args;
  try { args = JSON.parse(payload.arguments || '{}'); } catch { return []; }
  const name = payload.name || '';
  if (name === 'exec_command') return [tool('Bash', { command: args.cmd })];
  if (name === 'shell') return [tool('Bash', { command: shellCommand(args.command) })];
  if (/^(?:.*[._])?request_user_input(?:_async)?$/.test(name)) {
    return [tool('AskUserQuestion', { questions: (args.questions || []).map((q) => {
      const options = (q.options || []).slice(0, 4).map((o) => ({ label: typeof o === 'string' ? o : o.label, description: o.description || '' }));
      return {
        question: q.question || q.title || '', header: (q.header || 'Question').slice(0, 12), multiSelect: false,
        options: options.length >= 2 ? options : [{ label: 'Answer', description: '' }, { label: 'Other', description: '' }],
      };
    }) })];
  }
  if (/^(?:.*[._])?spawn_agent$/.test(name)) {
    const prompt = args.message || args.task || JSON.stringify(args);
    return [tool('Agent', { description: prompt.slice(0, 60), prompt })];
  }
  return [];
}

function execOutput(blocks, output) {
  const parts = (Array.isArray(output) ? output.slice(1) : [{ text: String(output || '') }]).map((item) => {
    try {
      const parsed = JSON.parse(item.text);
      if (typeof parsed.output === 'string') return { text: parsed.output, error: typeof parsed.exit_code === 'number' && parsed.exit_code !== 0 };
    } catch { /* Plain output. */ }
    return { text: item.text || '', error: false };
  });
  const bash = blocks.filter((block) => block.name === 'Bash');
  for (let i = 0; i < bash.length && i < parts.length; i++) {
    const assigned = i === bash.length - 1 ? parts.slice(i) : [parts[i]];
    bash[i].result = clamp(assigned.map((part) => part.text).join('\n'));
    bash[i].isError = assigned.some((part) => part.error);
  }
  const joined = parts.map((part) => part.text).join('\n');
  for (const block of blocks) if (block.name === 'WebSearch' || block.name === 'WebFetch') block.result = clamp(joined || 'Searched in Codex.');
}

function relativeLinks(text, cwd) {
  if (!cwd) return text;
  const root = path.resolve(cwd);
  return text.replace(/\]\((\/[^)]+)\)/g, (link, target) => {
    const relative = path.relative(root, target);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? `](${relative})` : link;
  });
}

/** Small metadata read for explicit rollout paths that are absent from the index. */
export function rolloutMeta(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const row = JSON.parse(buffer.subarray(0, read).toString('utf8').split('\n')[0]);
    const payload = row.type === 'session_meta' ? row.payload : {};
    return { sessionId: payload.session_id || payload.id || null, cwd: payload.cwd || null, startedAt: payload.timestamp || row.timestamp || null };
  } catch { return {}; } finally { fs.closeSync(fd); }
}

export function entryCounts(entries) {
  const counts = { user: 0, assistant: 0, commands: 0, fileChanges: 0, tools: 0 };
  for (const entry of entries) {
    if (!entry.tools) counts[entry.role]++;
    for (const block of entry.tools || []) {
      counts.tools++;
      if (block.name === 'Bash') counts.commands++;
      if (block.name === 'Edit' || block.name === 'Write') counts.fileChanges++;
    }
  }
  return counts;
}

/** Read complete JSONL records incrementally, retaining at most the newest 64MB. */
export function rolloutEntries(file, { from = 0, to = null, cwd = null } = {}) {
  let size;
  try { size = fs.statSync(file).size; } catch { return { entries: [], cursor: from }; }
  // `to` bounds a re-render to exactly what an earlier merge consumed.
  if (Number.isFinite(to)) size = Math.min(size, to);
  const original = from > size ? 0 : from;
  const start = Math.max(original, size - MAX_DELTA);
  const skipped = start - original;
  const entries = [];
  const pending = new Map();
  let hadCalls = false;
  let claudeTurn = null;
  let cursor = start;
  let dropPartial = skipped > 0;
  if (skipped) entries.push({ role: 'assistant', text: `… [${Math.round(skipped / 1e6)} MB of earlier Codex activity omitted] …` });
  const addTools = (blocks) => {
    if (!blocks.length) return;
    const last = entries.at(-1);
    if (last?.tools) last.tools.push(...blocks);
    else entries.push({ role: 'assistant', tools: blocks });
  };
  const consume = (line) => {
    let row;
    try { row = JSON.parse(line); } catch { return; }
    const p = row.payload || {};
    if (row.type === 'event_msg' && p.type === 'task_started' && p.turn_id?.startsWith('sb-claude-')) {
      claudeTurn = p.turn_id;
    }
    if (claudeTurn) {
      if (row.type === 'event_msg' && p.type === 'task_complete' && p.turn_id === claudeTurn) claudeTurn = null;
      return;
    }
    if (row.type === 'response_item') {
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const raw = textOf(p.content);
        const text = p.role === 'user' ? userText(raw) : relativeLinks(raw, cwd);
        if (text) entries.push({ role: p.role, text });
      } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
        hadCalls = true;
        const blocks = p.type === 'custom_tool_call' ? (p.name === 'exec' ? execTools(p.input) : []) : functionTools(p);
        addTools(blocks);
        if (p.call_id) pending.set(p.call_id, { blocks, custom: p.type === 'custom_tool_call' });
      } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
        const call = pending.get(p.call_id);
        if (!call) return;
        if (call.custom) execOutput(call.blocks, p.output);
        else for (const block of call.blocks) block.result = clamp(textOf(p.output));
        pending.delete(p.call_id);
      }
    } else if (row.type === 'event_msg' && p.type === 'item_completed') {
      const item = p.item || {};
      if (item.type === 'Plan') addTools([tool('ExitPlanMode', { plan: item.text }, 'Plan presented in Codex.')]);
      else if (!hadCalls && item.type === 'CommandExecution') addTools([tool('Bash', { command: shellCommand(item.command) }, clamp(item.aggregated_output || item.aggregatedOutput || 'No output recorded.'))]);
      else if (!hadCalls && item.type === 'FileChange') {
        for (const [file, change] of Object.entries(item.changes || {})) {
          if (change.unified_diff) addTools(edits(file, change.unified_diff.split('\n'), true));
          else if ((change.type?.type || change.type) === 'add' && typeof change.content === 'string') addTools([tool('Write', { file_path: file, content: change.content }, 'Applied in Codex.')]);
        }
      }
    }
  };
  const fd = fs.openSync(file, 'r');
  try {
    if (dropPartial) {
      const previous = Buffer.alloc(1);
      fs.readSync(fd, previous, 0, 1, start - 1);
      dropPartial = previous[0] !== 10;
    }
    const buffer = Buffer.alloc(CHUNK);
    let offset = start;
    let carry = Buffer.alloc(0);
    while (offset < size) {
      const read = fs.readSync(fd, buffer, 0, Math.min(CHUNK, size - offset), offset);
      if (!read) break;
      offset += read;
      const data = Buffer.concat([carry, buffer.subarray(0, read)]);
      let begin = 0, end;
      while ((end = data.indexOf(10, begin)) !== -1) {
        cursor += end - begin + 1;
        if (dropPartial) dropPartial = false;
        else consume(data.subarray(begin, end).toString('utf8'));
        begin = end + 1;
      }
      carry = Buffer.from(data.subarray(begin));
    }
  } finally { fs.closeSync(fd); }
  for (const entry of entries) for (const block of entry.tools || []) block.result = clamp(block.result);
  return { entries, cursor };
}
