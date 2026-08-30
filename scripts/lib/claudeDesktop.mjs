// Claude desktop's local agent mode ("Cowork") keeps each session in its own
// sandbox under Application Support, and inside that sandbox it writes an
// ordinary Claude Code transcript. So a desktop session is importable by exactly
// the same route as a CLI one — it just lives somewhere else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectDirFor } from './claudeTranscript.mjs';

export function desktopRoot() {
  return process.env.SWITCHBOARD_CLAUDE_DESKTOP_ROOT
    || path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions');
}

/** local_<id>.json sidecars, at whatever depth the app happens to nest them. */
function findSidecars(dir, depth, out) {
  if (depth < 0) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Never descend into a session's own sandbox; the sidecars sit beside it.
      if (!/^local_/.test(entry.name)) findSidecars(full, depth - 1, out);
    } else if (/^local_.+\.json$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Every transcript in a sandbox, newest first, subagent logs excluded. */
function transcriptsIn(sandbox) {
  const projects = path.join(sandbox, '.claude', 'projects');
  const found = [];
  const walk = (dir, depth) => {
    if (depth < 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'subagents') walk(full, depth - 1);
      } else if (entry.name.endsWith('.jsonl')) {
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        found.push({ file: full, mtime: stat.mtimeMs, bytes: stat.size });
      }
    }
  };
  walk(projects, 4);
  return found.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Claude desktop sessions that have a transcript worth importing, newest first.
 * Sessions the app has recorded but never actually ran are skipped.
 */
export function listDesktopSessions({ limit = 20, includeArchived = false } = {}) {
  const root = desktopRoot();
  if (!fs.existsSync(root)) return [];

  const sessions = [];
  for (const sidecar of findSidecars(root, 4, [])) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch { continue; }
    if (!includeArchived && meta.isArchived) continue;

    const sandbox = sidecar.replace(/\.json$/, '');
    const transcripts = transcriptsIn(sandbox);
    if (!transcripts.length) continue;

    // The sidecar names the CLI session, so prefer that file; if the app has
    // rotated it, the newest transcript in the sandbox is the live one.
    const named = meta.cliSessionId
      && transcripts.find((t) => path.basename(t.file) === `${meta.cliSessionId}.jsonl`);
    const chosen = named || transcripts[0];

    sessions.push({
      sessionId: meta.sessionId || path.basename(sandbox),
      title: meta.title || null,
      file: chosen.file,
      bytes: chosen.bytes,
      mtime: Math.max(chosen.mtime, meta.lastActivityAt || 0),
      cwd: meta.cwd || sandbox,
      archived: Boolean(meta.isArchived),
      model: meta.model || null,
      via: named ? 'sidecar' : 'newest transcript in sandbox',
    });
  }

  return sessions.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** Resolve a selector — index, session-id prefix, or title substring. */
export function pickDesktopSession(sessions, selector) {
  if (!selector) return sessions[0];
  if (/^\d+$/.test(selector)) {
    const chosen = sessions[Number(selector) - 1];
    if (!chosen) throw new Error(`No session ${selector}; the list has ${sessions.length}.`);
    return chosen;
  }
  const bare = selector.replace(/^local_(ditto_)?/, '');
  const byId = sessions.filter((s) => s.sessionId.replace(/^local_(ditto_)?/, '').startsWith(bare));
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) throw new Error(`"${selector}" matches ${byId.length} sessions; use more characters.`);

  const needle = selector.toLowerCase();
  const byTitle = sessions.filter((s) => (s.title || '').toLowerCase().includes(needle));
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) throw new Error(`"${selector}" matches ${byTitle.length} titles; be more specific.`);
  throw new Error(`No Claude desktop session matches "${selector}".`);
}

/**
 * Codex only imports Claude sessions it can find under ~/.claude/projects, so a
 * desktop transcript has to exist there first. Copy it in — which also makes the
 * conversation resumable with `claude --resume` — and hand back the local path.
 * Re-running is a no-op once the copy is current.
 */
export function materialiseDesktopSession(session, cwd) {
  const dir = projectDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(session.file));

  const source = fs.readFileSync(session.file);
  let current = null;
  try { current = fs.readFileSync(dest); } catch { /* not copied yet */ }
  if (!current || !current.equals(source)) fs.writeFileSync(dest, source);

  return { path: dest, copied: !current || !current.equals(source) };
}
