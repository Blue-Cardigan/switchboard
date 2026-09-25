// Handing a conversation to a harness that has no session file switchboard can
// write.
//
// Most harnesses keep conversations in a format switchboard can author, so a
// handoff is a file and an id. The rest — Antigravity's protobuf-in-SQLite, and
// every CLI whose store is undocumented or version-bound — get the same
// conversation through their own front door instead: a Markdown seed, opened as
// the first prompt of a new session. The harness mints its own id when it
// starts, so what a seed carries is an intention, not a session.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Seeds are transcripts of the user's own work: kept out of the world. */
export function seedsDir() {
  return path.join(os.homedir(), '.claude', 'switchboard', 'seeds');
}

export function seedPath(id) {
  return path.join(seedsDir(), `${id}.md`);
}

/** The launcher that opens a harness on a seed, written beside it. */
export function seedScript(id) {
  return path.join(seedsDir(), `${id}.sh`);
}

/** Seed ids belong to a session the harness has not started yet. */
export function isSeed(id) {
  return Boolean(id) && fs.existsSync(seedScript(String(id)));
}

function labelFromPreamble(preamble) {
  const match = /^\[Imported from ([^\]]+)\]/.exec(String(preamble || ''));
  return match ? match[1] : 'the other harness';
}

/** Yesterday's seeds are already open somewhere, or were abandoned. */
function sweep(dir, keep) {
  for (const name of fs.readdirSync(dir)) {
    const stale = path.join(dir, name);
    try {
      if (!keep.includes(stale) && Date.now() - fs.statSync(stale).mtimeMs > 36e5) fs.unlinkSync(stale);
    } catch { /* someone else's to worry about */ }
  }
}

/**
 * Write the conversation as one Markdown file for a harness to open on.
 * Returns the seed's own id — the harness's id for it does not exist yet.
 */
export function stageSeed({ cwd, entries, preamble }) {
  const dir = seedsDir();
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const file = seedPath(id);
  const label = labelFromPreamble(preamble);

  const body = entries.map((entry) => (
    entry.role === 'user' ? `## You\n\n${entry.text}` : `## ${label}\n\n${entry.text}`
  ));
  fs.writeFileSync(file, `${[preamble, '', ...body].join('\n\n')}\n`, { mode: 0o600 });
  sweep(dir, [file, seedScript(id)]);

  return { id, file, cwd, entries: entries.length };
}

/** The shell line that opens the harness on a seed, as a runnable script. */
export function writeLauncher(id, command) {
  const file = seedScript(id);
  fs.writeFileSync(file, `#!/bin/sh\n${command}\n`, { mode: 0o700 });
  return file;
}

/** A path as one shell word. Seed paths are ours, but they still get quoted. */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
