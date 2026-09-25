// Gemini CLI conversations on disk: where they live, and how to write one.
//
// Gemini records a session as a JSONL stream under
//   ~/.gemini/tmp/<slug>/chats/session-<timestamp>-<8 chars of id>.jsonl
// whose first line is metadata and whose remaining lines are messages. On
// `--resume <uuid>` it replays those messages into the model's history, so a
// file we write by hand resumes exactly like one Gemini wrote itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordAuthored } from './claudeTranscript.mjs';

const PROJECT_ROOT_FILE = '.project_root';
const PREFIX = 'session-';

// Gemini reads this location from the home directory with no override of its
// own; the variable exists so a test can point both at the same throwaway tree.
function geminiDir() {
  return process.env.SWITCHBOARD_GEMINI_HOME || path.join(os.homedir(), '.gemini');
}

function registryPath() {
  return path.join(geminiDir(), 'projects.json');
}

/** The two trees Gemini keys by project slug; a slug owns its name in both. */
function baseDirs() {
  return [path.join(geminiDir(), 'tmp'), path.join(geminiDir(), 'history')];
}

/**
 * Gemini's own normalisation for the project registry: resolve, and case-fold
 * on Windows only. It does case-fold on macOS elsewhere in its codebase — copy
 * that one by mistake and Gemini stops recognising its own key, then allocates
 * a second slug for a directory it already had.
 */
function normalise(dir) {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'project';
}

function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.projects ? parsed : { projects: {} };
  } catch {
    return { projects: {} };
  }
}

/**
 * The slug Gemini uses for a directory, or null if it has never opened it.
 * Reading never invents one: a slug is a claim on a name in two trees, and
 * making that claim for a session we might not write would leave litter.
 */
export function projectSlug(cwd) {
  return readRegistry().projects[normalise(cwd)] || null;
}

/**
 * The slug for a directory, claiming one the way Gemini would if it is new.
 * Same algorithm, same ownership markers, so Gemini adopts it rather than
 * allocating a second slug for the same project the next time it runs.
 */
export function claimProjectSlug(cwd) {
  const existing = projectSlug(cwd);
  if (existing) return existing;

  const project = normalise(cwd);
  const registry = readRegistry();
  const taken = new Set(Object.values(registry.projects));
  const base = slugify(path.basename(path.resolve(cwd)));

  for (let counter = 0; ; counter += 1) {
    const candidate = counter === 0 ? base : `${base}-${counter}`;
    if (taken.has(candidate)) continue;
    const dirs = baseDirs().map((dir) => path.join(dir, candidate));
    const owned = dirs.every((dir) => {
      const marker = path.join(dir, PROJECT_ROOT_FILE);
      if (!fs.existsSync(marker)) return true;
      try {
        return normalise(fs.readFileSync(marker, 'utf8').trim()) === project;
      } catch {
        return false;
      }
    });
    if (!owned) continue;

    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
      const marker = path.join(dir, PROJECT_ROOT_FILE);
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, project, 'utf8');
    }
    registry.projects[project] = candidate;
    fs.mkdirSync(geminiDir(), { recursive: true });
    fs.writeFileSync(registryPath(), `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    return candidate;
  }
}

/** Where a directory's conversations are kept, if Gemini knows the directory. */
export function chatsDirFor(cwd, { claim = false } = {}) {
  const slug = claim ? claimProjectSlug(cwd) : projectSlug(cwd);
  return slug ? path.join(geminiDir(), 'tmp', slug, 'chats') : null;
}

function readRows(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/** A session file as its metadata plus its surviving messages, or null. */
export function readSession(file) {
  const rows = readRows(file);
  const meta = rows.find((row) => typeof row.sessionId === 'string' && typeof row.projectHash === 'string');
  if (!meta) return null;
  const updates = rows.filter((row) => row.$set).reduce((acc, row) => ({ ...acc, ...row.$set }), {});
  const messages = rows.filter((row) => typeof row.id === 'string');
  return { ...meta, ...updates, messages, file };
}

/** Conversations in a directory, newest last — the order `--resume N` counts in. */
export function listSessions(cwd, { limit = 20 } = {}) {
  const dir = chatsDirFor(cwd);
  if (!dir || !fs.existsSync(dir)) return [];
  const found = fs.readdirSync(dir)
    .filter((name) => name.startsWith(PREFIX) && /\.jsonl?$/.test(name))
    .map((name) => readSession(path.join(dir, name)))
    .filter((meta) => meta && meta.kind !== 'subagent')
    .map((meta) => ({
      id: meta.sessionId,
      source: meta.file,
      cwd,
      startTime: meta.startTime,
      lastUpdated: meta.lastUpdated,
      messages: meta.messages.length,
      summary: meta.summary || firstUserText(meta.messages),
    }))
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  return limit ? found.slice(-limit) : found;
}

function firstUserText(messages) {
  const first = messages.find((msg) => msg.type === 'user');
  if (!first) return '';
  const { content } = first;
  return (typeof content === 'string' ? content : (content || []).map((p) => p.text || '').join(''))
    .split('\n')[0]
    .slice(0, 120);
}

function fileNameFor(sessionId, startedAt = new Date()) {
  const stamp = startedAt.toISOString().slice(0, 16).replace(/:/g, '-');
  return `${PREFIX}${stamp}-${sessionId.slice(0, 8)}.jsonl`;
}

/**
 * Write a Gemini session that `gemini --resume <id>` loads as real history.
 *
 * Gemini drops any user message beginning with `/` or `?` when it rebuilds
 * history — those are its command prefixes, and it trims before it checks — so
 * an imported turn that opens with one is quoted to survive the crossing.
 */
export function writeSession({ cwd, entries, preamble }) {
  const dir = chatsDirFor(cwd, { claim: true });
  fs.mkdirSync(dir, { recursive: true });

  const sessionId = crypto.randomUUID();
  const now = new Date();
  const timestamp = now.toISOString();
  const file = path.join(dir, fileNameFor(sessionId, now));

  const rows = [{
    sessionId,
    projectHash: crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex'),
    startTime: timestamp,
    lastUpdated: timestamp,
    kind: 'main',
  }];

  const opensWithUser = entries[0]?.role === 'user';
  const all = preamble
    ? [{ role: 'user', text: `${preamble}\n\n${opensWithUser ? entries[0].text : ''}`.trim() },
       ...(opensWithUser ? entries.slice(1) : entries)]
    : entries;

  for (const entry of all) {
    const text = entry.role === 'user' ? entry.text.replace(/^\s*([/?])/, '> $1') : entry.text;
    rows.push({
      id: crypto.randomUUID(),
      timestamp,
      type: entry.role === 'user' ? 'user' : 'gemini',
      content: text,
    });
  }

  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  recordAuthored(file);
  return { sessionId, file, rows: rows.length - 1 };
}

/** Duplicate a Gemini session under a new id, leaving the original alone. */
export function forkSession({ source, cwd, model = null }) {
  const rows = readRows(source);
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const dir = chatsDirFor(cwd, { claim: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileNameFor(sessionId, now));

  const copied = rows.map((row) => {
    const next = { ...row };
    if (typeof next.sessionId === 'string') next.sessionId = sessionId;
    if (next.$set?.sessionId) next.$set = { ...next.$set, sessionId };
    if (model && next.type === 'gemini' && 'model' in next) next.model = model;
    return next;
  });

  fs.writeFileSync(file, `${copied.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  recordAuthored(file);
  return { sessionId, file, rows: copied.filter((row) => typeof row.id === 'string').length };
}

/** The session id a file declares, rather than the 8 characters in its name. */
export function sessionIdOf(source) {
  try {
    return readSession(source)?.sessionId || null;
  } catch {
    return null;
  }
}
