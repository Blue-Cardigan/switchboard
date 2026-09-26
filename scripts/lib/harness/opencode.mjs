// OpenCode's documented session export/import keeps the conversation as turns.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../state.mjs';
import { findAncestor, onPath } from '../proc.mjs';
import { isSeed, seedScript } from '../seed.mjs';
import { buildPreamble } from '../claudeTranscript.mjs';

function cli(args, cwd) {
  return execFileSync('opencode', args, { cwd, encoding: 'utf8', timeout: 30000, maxBuffer: 20 * 1024 * 1024 });
}
const id = (prefix) => `${prefix}_switchboard_${crypto.randomUUID().replaceAll('-', '')}`;
function command(kind, args, cwd) {
  const major = Number(cli(['--version'], cwd).trim().split('.')[0]);
  const prefix = major >= 2 ? ['session', kind] : [kind];
  return cli([...prefix, ...args], cwd);
}

export function importDocument(entries, cwd, preamble = '') {
  const sessionID = id('ses');
  const now = Date.now();
  const messages = [];
  let parentID = null;
  const ordered = preamble ? [{ role: 'user', text: preamble }, ...entries] : entries;
  const [providerID, modelID] = (process.env.OPENCODE_MODEL || 'opencode/big-pickle').split('/');
  for (const [index, entry] of ordered.entries()) {
    if (!['user', 'assistant'].includes(entry.role) || !entry.text) continue;
    const messageID = `msg_${String(now + index).padStart(13, '0')}_${crypto.randomUUID().replaceAll('-', '')}`;
    const info = entry.role === 'user'
      ? { id: messageID, sessionID, role: 'user', time: { created: now + index }, agent: 'build', model: { providerID, modelID } }
      : { id: messageID, sessionID, role: 'assistant', time: { created: now + index, completed: now + index }, parentID: parentID || messageID, modelID, providerID, mode: 'build', agent: 'build', path: { cwd, root: cwd }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
    messages.push({ info, parts: [{ id: id('prt'), sessionID, messageID, type: 'text', text: entry.text }] });
    if (entry.role === 'user') parentID = messageID;
  }
  if (!messages.length) throw new Error('No conversation turns to import into OpenCode.');
  return { info: { id: sessionID, slug: sessionID, projectID: 'switchboard', directory: cwd, title: 'Switchboard handoff', version: '1.0.0', time: { created: now, updated: now } }, messages };
}

export default {
  id: 'opencode', label: 'OpenCode', bin: 'opencode',
  install: 'curl -fsSL https://opencode.ai/install | bash',
  docs: 'https://opencode.ai/v2/docs/cli/commands/',
  capabilities: { read: true, write: true, resume: true, fork: false, headless: true, hooks: false },
  resumeArgv(sessionID) { return isSeed(sessionID) ? ['sh', seedScript(sessionID)] : ['opencode', '--session', sessionID]; },
  hostEnv() { return findAncestor(/(^|\/)opencode$/) !== null; },
  live(cwd) {
    if (!this.hostEnv()) return null;
    const [row] = this.list({ cwd, limit: 1 });
    return row && { id: row.id, source: row.id, cwd, via: 'newest OpenCode session in this directory' };
  },
  list({ cwd = process.cwd(), limit = 20 } = {}) {
    if (!onPath('opencode')) return [];
    const rows = JSON.parse(cli(['session', 'list', '--max-count', String(limit), '--format', 'json'], cwd));
    const canonical = fs.realpathSync(cwd);
    return (Array.isArray(rows) ? rows : []).filter((row) => !cwd || row.directory === canonical)
      .map((row) => ({ id: row.id, cwd: row.directory, title: row.title, mtime: row.time?.updated || row.updated }));
  },
  read(session) {
    const data = JSON.parse(command('export', [session.id || session.source], session.cwd));
    const entries = data.messages.flatMap(({ info, parts }) => {
      const text = parts.filter((part) => part.type === 'text' && !part.ignored).map((part) => part.text).join('\n').trim();
      return text ? [{ role: info.role, text }] : [];
    });
    const counts = { user: entries.filter((e) => e.role === 'user').length, assistant: entries.filter((e) => e.role === 'assistant').length, commands: 0, fileChanges: 0 };
    return { entries, meta: { sessionId: data.info.id, cwd: session.cwd }, counts, trimmed: false,
      preamble: buildPreamble({ sessionId: data.info.id, cwd: session.cwd }, counts, false, { name: 'OpenCode', unit: 'session' }) };
  },
  write({ entries, cwd, preamble }) {
    if (!onPath('opencode')) throw new Error(`OpenCode is not installed. ${this.install}`);
    const data = importDocument(entries, cwd, preamble);
    const dir = path.join(ROOT, 'opencode-imports');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${data.info.id}.json`);
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    command('import', [file], cwd);
    fs.unlinkSync(file);
    return { id: data.info.id, source: data.info.id, cwd, rows: data.messages.length };
  },
  store() { return null; },
  sessionIdOf(source) { return source; },
};
