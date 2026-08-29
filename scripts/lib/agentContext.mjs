// Which agent, if any, is this command running inside?
//
// The handoff and the claim are the same command (`cc` / `cx`), so it has to
// tell "I am inside Codex, hand this conversation over" apart from "I am at a
// bare shell prompt, finish the handoff that is already staged here".
import { execFileSync } from 'node:child_process';
import { findCodexAncestor } from './currentSession.mjs';

function ps(field, pid) {
  try {
    return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Walk up the process tree looking for the Claude Code TUI. */
export function findClaudeAncestor(startPid = process.pid, maxDepth = 12) {
  let pid = startPid;
  for (let i = 0; i < maxDepth; i += 1) {
    const parent = ps('ppid', pid);
    if (!parent || parent === '0' || parent === '1') return null;
    if (/(^|\/)claude$/.test(ps('comm', parent))) return Number(parent);
    pid = Number(parent);
  }
  return null;
}

/** 'codex' | 'claude' | null (null = a plain shell prompt). */
export function currentAgent() {
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID) return 'codex';
  if (findCodexAncestor()) return 'codex';
  if (findClaudeAncestor()) return 'claude';
  return null;
}

/**
 * Did the shell that launched this agent source the switchboard wrapper?
 * The wrapper exports this, and both agents pass their environment down to
 * the commands they run, so its absence means no shell function is waiting to
 * claim the handoff when the agent exits — the user has to finish it by hand.
 */
export function wrapperActive() {
  return process.env.SWITCHBOARD_WRAPPER === '1';
}
