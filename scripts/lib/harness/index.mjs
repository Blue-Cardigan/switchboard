// The registry. Everything that used to branch on "codex or claude?" asks here
// instead, so a third harness is a file in this directory rather than an edit
// to every call site.
import claude from './claude.mjs';
import codex from './codex.mjs';
import antigravity from './antigravity.mjs';
import gemini from './gemini.mjs';
import { currentAgent } from '../agentContext.mjs';

const REGISTERED = [claude, codex, antigravity, gemini];

export const harnesses = Object.freeze(
  Object.fromEntries(REGISTERED.map((h) => [h.id, h])),
);

export function get(id) {
  const found = harnesses[id];
  if (!found) throw new Error(`Unknown harness "${id}". Known: ${ids().join(', ')}.`);
  return found;
}

export function ids() {
  return REGISTERED.map((h) => h.id);
}

/** Every harness that can do a thing — `supporting('fork')`, say. */
export function supporting(capability) {
  return REGISTERED.filter((h) => h.capabilities[capability]);
}

/**
 * Which harness is this process running inside. Process ancestry is the
 * authority — it is what identifies the *session*, not just the family — and
 * the environment is a fallback for the harnesses that mark it.
 */
export function host() {
  const byAncestry = currentAgent();
  if (byAncestry && harnesses[byAncestry]) return harnesses[byAncestry];
  const byEnv = REGISTERED.find((h) => h.hostEnv?.());
  return byEnv || null;
}

export function resumeArgv(harnessId, sessionId) {
  return get(harnessId).resumeArgv(sessionId);
}
