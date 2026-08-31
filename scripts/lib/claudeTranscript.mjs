import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function projectDirFor(cwd) {
  const slug = path.resolve(cwd).replace(/[/.]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

// Transcripts switchboard put into a project directory itself — imported Codex
// threads and copied desktop sessions. They sit next to real ones and are newer
// than all of them, so "the newest transcript here is the live conversation"
// would otherwise pick one of ours. Size and mtime are recorded as written: once
// Claude Code resumes a transcript it appends to it, the record stops matching,
// and the file counts as a live conversation again.
const AUTHORED = path.join(os.homedir(), '.claude', 'switchboard', 'authored.json');
const AUTHORED_KEEP = 200;

function readAuthored() {
  try { return JSON.parse(fs.readFileSync(AUTHORED, 'utf8')); } catch { return {}; }
}

export function recordAuthored(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return; }
  const index = readAuthored();
  index[path.resolve(file)] = { bytes: stat.size, mtimeMs: Math.round(stat.mtimeMs), at: Date.now() };

  const entries = Object.entries(index).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  try {
    fs.mkdirSync(path.dirname(AUTHORED), { recursive: true });
    fs.writeFileSync(AUTHORED, `${JSON.stringify(Object.fromEntries(entries.slice(0, AUTHORED_KEEP)), null, 2)}\n`);
  } catch { /* the index is an optimisation, never a requirement */ }
}

/** True when switchboard wrote this file and nothing has appended to it since. */
export function isPristineAuthored(file) {
  const record = readAuthored()[path.resolve(file)];
  if (!record) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  return stat.size === record.bytes && Math.round(stat.mtimeMs) === record.mtimeMs;
}

/** Claude Code rebuilds API messages from these rows, so same-role runs are merged. */
function normalise(entries) {
  const merged = [];
  for (const entry of entries) {
    const last = merged[merged.length - 1];
    if (last && last.role === entry.role) last.text = `${last.text}\n\n${entry.text}`;
    else merged.push({ ...entry });
  }
  return merged;
}

/** Fold the shell/file activity trail into the assistant turn it belongs to. */
export function eventsToEntries(events) {
  const entries = [];
  let pending = [];

  const flushInto = (target) => {
    if (!pending.length) return '';
    const block = `\n\n[Codex activity]\n${pending.join('\n')}`;
    pending = [];
    return target ? block : block.trim();
  };

  for (const event of events) {
    if (event.kind === 'activity') { pending.push(event.text); continue; }
    if (event.role === 'assistant') {
      entries.push({ role: 'assistant', text: `${event.text}${flushInto(true)}` });
    } else {
      if (pending.length) entries.push({ role: 'assistant', text: flushInto(false) });
      entries.push({ role: 'user', text: event.text });
    }
  }
  if (pending.length) entries.push({ role: 'assistant', text: flushInto(false) });
  return normalise(entries);
}

export function buildPreamble(meta, counts, truncated) {
  const lines = [
    '[Imported from Codex]',
    '',
    `This conversation started in Codex${meta.model ? ` on ${meta.model}` : ''}` +
      `${meta.startedAt ? `, ${meta.startedAt.slice(0, 16).replace('T', ' ')}` : ''}` +
      `${meta.sessionId ? ` (thread ${meta.sessionId.slice(0, 8)})` : ''}, working in ${meta.cwd || 'an unknown directory'}.`,
    `Codex ran ${counts.commands} command(s) and edited files ${counts.fileChanges} time(s) across ` +
      `${counts.user} prompt(s) and ${counts.assistant} repl(ies).` +
      (truncated ? ' The middle of the session was dropped for length; the opening and the recent tail are below.' : ''),
    '',
    'The assistant turns that follow were written by Codex, not by you. Treat them as established',
    'context and honour any commitments in them, but never describe that work as something you did.',
    'Shell commands and edits are summarised as [Codex activity]; their full output is not preserved,',
    'so re-read files before relying on their contents. Continue the work from here.',
    '',
    '--- imported conversation follows ---',
  ];
  return lines.join('\n');
}

/**
 * Write a Claude Code transcript that `claude --resume <id>` will load as real history.
 */
export function writeTranscript({ cwd, entries, preamble, gitBranch = '', version = '2.1.251' }) {
  const dir = projectDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });

  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const base = {
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: path.resolve(cwd),
    sessionId,
    version,
    gitBranch,
  };

  const rows = [];
  let parentUuid = null;
  const all = preamble
    ? [{ role: 'user', text: `${preamble}\n\n${entries[0]?.role === 'user' ? entries[0].text : ''}`.trim() },
       ...(entries[0]?.role === 'user' ? entries.slice(1) : entries)]
    : entries;

  for (const entry of all) {
    const uuid = crypto.randomUUID();
    if (entry.role === 'user') {
      rows.push({
        ...base,
        parentUuid,
        promptId: crypto.randomUUID(),
        type: 'user',
        uuid,
        timestamp,
        permissionMode: 'auto',
        origin: { kind: 'human' },
        promptSource: 'typed',
        message: { role: 'user', content: entry.text },
      });
    } else {
      rows.push({
        ...base,
        parentUuid,
        type: 'assistant',
        uuid,
        timestamp,
        session_id: sessionId,
        requestId: 'req_codex_import',
        message: {
          model: 'claude-opus-5',
          id: `msg_${uuid.replace(/-/g, '').slice(0, 24)}`,
          type: 'message',
          role: 'assistant',
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: entry.text }],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            service_tier: 'standard',
          },
        },
      });
    }
    parentUuid = uuid;
  }

  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  recordAuthored(file);
  return { sessionId, file, rows: rows.length };
}
