#!/usr/bin/env node
// Staging point for an in-place handoff. The agent being left writes here; the
// shell that launched it claims the entry once that agent exits.
//   stage <tty> <target> <id> <cwd>     target = any registered harness
//   claim <tty> [expectedTarget] [--any-age]   prints "<target>\t<id>\t<cwd>\t<argv>"
//   peek  <tty>                         same, without consuming the entry
//
// The argv field is how the shell reopens the conversation without knowing
// which harnesses exist: it execs what the harness adapter names.
//
// The age limit guards the automatic path only: a shell wrapper claiming on
// agent exit must not resurrect a handoff the user abandoned hours ago. When
// the user types `cc`/`cx` at a prompt they are asking for it explicitly, so
// that path passes --any-age.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/state.mjs';
import { harnesses } from './lib/harness/index.mjs';

const DIR = path.join(ROOT, 'pending');
const MAX_AGE_MS = 30 * 60 * 1000;
const key = (tty) => `${String(tty).replace(/^\/dev\//, '').replace(/[^A-Za-z0-9_-]/g, '_')}.json`;

const [verb, ...args] = process.argv.slice(2);

if (verb === 'stage') {
  const [tty, target, id, cwd] = args;
  if (!tty || !target || !id || !cwd) { console.error('usage: pending.mjs stage <tty> <target> <id> <cwd>'); process.exit(1); }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, key(tty)), JSON.stringify({ target, id, cwd, at: Date.now() }));
} else if (verb === 'claim' || verb === 'peek') {
  const anyAge = args.includes('--any-age');
  const [tty, expected] = args.filter((a) => !a.startsWith('--'));
  const file = path.join(DIR, key(tty || ''));
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { process.exit(0); }
  if (expected && data.target !== expected) process.exit(0); // leave it for the right wrapper
  if (!data || (!anyAge && Date.now() - (data.at || 0) > MAX_AGE_MS)) {
    if (verb === 'claim') { try { fs.unlinkSync(file); } catch { /* best effort */ } }
    process.exit(0);
  }
  if (verb === 'claim') { try { fs.unlinkSync(file); } catch { /* best effort */ } }
  const argv = harnesses[data.target]?.resumeArgv(data.id) ?? [];
  process.stdout.write(`${data.target}\t${data.id}\t${data.cwd}\t${argv.join(' ')}\n`);
} else {
  console.error('usage: pending.mjs stage|claim|peek');
  process.exit(1);
}
