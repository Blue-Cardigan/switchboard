import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPristineAuthored, recordAuthored } from './claudeTranscript.mjs';
import { compactClaudeTranscript } from './compactClaude.mjs';

const IMPORT_COMPLETED = 'externalAgentConfig/import/completed';

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Minimal newline-delimited JSON-RPC client for `codex app-server`. */
class AppServer {
  constructor(cwd) {
    this.cwd = cwd;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.onNotification = null;
    this.buffer = '';
  }

  start() {
    this.proc = spawn('codex', ['app-server'], {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.consume(chunk));
    this.proc.stderr.resume();
    this.exited = new Promise((resolve) => this.proc.on('close', resolve));
  }

  consume(chunk) {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) {
        let msg;
        try { msg = JSON.parse(line); } catch { msg = null; }
        if (msg) this.dispatch(msg);
      }
      idx = this.buffer.indexOf('\n');
    }
  }

  dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      this.notifications.push(msg.method);
      this.onNotification?.(msg);
    }
  }

  send(message) {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 120000) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Codex app-server did not answer ${method} in time.`));
      }, timeoutMs);
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  stop() {
    try { this.proc.stdin.end(); } catch { /* already closed */ }
    try { this.proc.kill(); } catch { /* already gone */ }
  }
}

// Codex keeps two import ledgers: one for its own external-agent importer, and
// one for the desktop app's Claude sync. They record the same thing under
// different key styles, so check both — an import the ChatGPT app already did
// should be reused rather than repeated.
const LEDGERS = [
  { file: 'external_agent_session_imports.json', source: 'source_path', sha: 'content_sha256', thread: 'imported_thread_id' },
  { file: 'claude-cowork-import-history.json', source: 'sourcePath', sha: 'contentSha256', thread: 'importedThreadId' },
];

function ledgerThreadId(sourcePath, sha) {
  const canonical = fs.realpathSync(sourcePath);
  for (const keys of LEDGERS) {
    let ledger;
    try { ledger = JSON.parse(fs.readFileSync(path.join(codexHome(), keys.file), 'utf8')); } catch { continue; }
    const records = Array.isArray(ledger?.records) ? ledger.records : [];
    const match = records
      .filter((r) => r?.[keys.source] === canonical && r?.[keys.sha] === sha && typeof r?.[keys.thread] === 'string')
      .at(-1);
    if (match) return match[keys.thread];
  }
  return null;
}

/**
 * Every record Codex holds for this content, whatever path it filed it under.
 * The exact (path, sha) lookup above is the answer; this is what gets reported
 * when there isn't one, because "finished but recorded nothing" is otherwise a
 * dead end — Codex has already closed, and the next run hashes a different file.
 */
function ledgerRecordsFor(sha) {
  const found = [];
  for (const keys of LEDGERS) {
    let ledger;
    try { ledger = JSON.parse(fs.readFileSync(path.join(codexHome(), keys.file), 'utf8')); } catch { continue; }
    for (const record of Array.isArray(ledger?.records) ? ledger.records : []) {
      if (record?.[keys.sha] === sha && typeof record?.[keys.thread] === 'string') {
        found.push({ file: keys.file, source: record[keys.source], thread: record[keys.thread] });
      }
    }
  }
  return found;
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// A live Claude transcript can grow while Codex imports it. Codex also keeps
// the first import for a source path, even when that file later changes. Give
// each version its own stable, UUID-shaped filename so the ledger can identify
// the exact conversation that was imported.
/**
 * Claude Code appends a row while we are reading it, so the tail of a live
 * transcript can be half a line. Codex parses the whole file or takes none of
 * it, and a partial last row is indistinguishable from a corrupt session.
 */
function completeLines(bytes) {
  const end = bytes.lastIndexOf(0x0a);
  if (end === -1) return bytes;
  const tail = bytes.subarray(end + 1);
  if (!tail.length) return bytes;
  try {
    JSON.parse(tail.toString('utf8'));
    return bytes;
  } catch {
    return bytes.subarray(0, end + 1);
  }
}

function importSnapshot(source, bytes, sha) {
  if (isPristineAuthored(source) && digest(fs.readFileSync(source)) === sha) return source;
  const id = `${sha.slice(0, 8)}-${sha.slice(8, 12)}-4${sha.slice(13, 16)}-8${sha.slice(17, 20)}-${sha.slice(20, 32)}`;
  const snapshot = path.join(path.dirname(source), `${id}.jsonl`);
  try {
    fs.writeFileSync(snapshot, bytes, { flag: 'wx', mode: 0o600 });
    recordAuthored(snapshot);
  } catch (err) {
    if (err.code !== 'EEXIST' || digest(fs.readFileSync(snapshot)) !== sha) throw err;
  }
  return snapshot;
}

/**
 * Hand a Claude Code transcript to Codex's own external-agent importer and
 * return the Codex thread id it produced.
 */
export async function importClaudeSession(sourcePath, cwd) {
  const source = fs.realpathSync(sourcePath);
  // Codex only imports sessions it finds under ~/.claude/projects. Hand it
  // anything else and it quietly ignores the request and imports its own default
  // set instead, so refuse rather than return someone else's thread. Claude
  // desktop transcripts are copied in first — see materialiseDesktopSession.
  const projects = path.join(os.homedir(), '.claude', 'projects');
  if (!source.startsWith(projects + path.sep)) {
    throw new Error(`Codex imports Claude sessions only from ${projects}`);
  }

  const original = completeLines(fs.readFileSync(source));
  const bytes = compactClaudeTranscript(original).bytes;
  const sha = digest(bytes);
  const existing = ledgerThreadId(source, sha);
  const size = { originalBytes: original.length, importedBytes: bytes.length };
  if (existing) return { threadId: existing, reused: true, ...size };

  const importedSource = importSnapshot(source, bytes, sha);
  const importedExisting = ledgerThreadId(importedSource, sha);
  if (importedExisting) return { threadId: importedExisting, reused: true, ...size };

  const server = new AppServer(cwd);
  server.start();
  try {
    await server.request('initialize', {
      clientInfo: { name: 'switchboard', title: 'Switchboard', version: '0.1.0' },
    });
    server.notify('initialized', {});

    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for Codex to finish the import.')), 180000);
      server.onNotification = (msg) => {
        if (msg.method === IMPORT_COMPLETED) { clearTimeout(timer); resolve(); }
      };
    });

    await server.request('externalAgentConfig/import', {
      migrationItems: [{
        itemType: 'SESSIONS',
        description: `Transfer Claude session ${path.basename(source)}`,
        cwd: null,
        details: {
          plugins: [], sessions: [{ path: importedSource, cwd, title: null }],
          mcpServers: [], hooks: [], subagents: [], commands: [],
        },
      }],
    });
    await completed;
  } finally {
    server.stop();
  }

  const threadId = ledgerThreadId(importedSource, sha);
  if (!threadId) {
    const elsewhere = ledgerRecordsFor(sha).filter((r) => r.source !== importedSource);
    throw new Error(
      'Codex reported the import finished but recorded no thread for it.\n' +
      `  imported: ${importedSource}\n` +
      `  sha:      ${sha}\n` +
      (elsewhere.length
        ? `  the same content is filed under ${elsewhere.map((r) => r.source).join(', ')} — reopen it with: codex resume ${elsewhere.at(-1).thread}`
        : `  nothing in ${LEDGERS.map((l) => l.file).join(' or ')} matches it; run Codex's own /import to see what it says`),
    );
  }
  return { threadId, reused: false, ...size };
}
