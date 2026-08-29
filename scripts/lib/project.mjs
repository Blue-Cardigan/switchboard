import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code stores transcripts under ~/.claude/projects/<cwd with / and . replaced by ->. */
export function projectDir(cwd) {
  const slug = path.resolve(cwd).replace(/[/.]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

/** Newest transcript for this directory — the running session, in practice. */
export function findTranscript(cwd) {
  const dir = projectDir(cwd);
  let entries;
  try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
  let best = null;
  for (const name of entries) {
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!best || stat.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: stat.mtimeMs };
  }
  return best ? best.path : null;
}
