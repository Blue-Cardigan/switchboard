import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function ledgerThreadId(sourcePath) {
  const canonical = fs.realpathSync(sourcePath);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(canonical)).digest('hex');
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

  const existing = ledgerThreadId(source);
  if (existing) return { threadId: existing, reused: true };

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
          plugins: [], sessions: [{ path: source, cwd, title: null }],
          mcpServers: [], hooks: [], subagents: [], commands: [],
        },
      }],
    });
    await completed;
  } finally {
    server.stop();
  }

  const threadId = ledgerThreadId(source);
  if (!threadId) throw new Error('Codex reported the import finished but recorded no thread id.');
  return { threadId, reused: false };
}
