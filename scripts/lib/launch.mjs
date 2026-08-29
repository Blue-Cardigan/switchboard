import { execFileSync } from 'node:child_process';

function appleQuote(text) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

export function resumeCommand(sessionId, cwd) {
  return `cd ${shellQuote(cwd)} && claude --resume ${sessionId}`;
}

/**
 * Open the resumed session in a new Terminal.app window. Returns false if the
 * terminal could not be driven, so the caller can fall back to printing.
 */
export function openInTerminal(sessionId, cwd) {
  const command = appleQuote(resumeCommand(sessionId, cwd));
  const script = `tell application "Terminal"\n  activate\n  do script "${command}"\nend tell`;
  try {
    execFileSync('osascript', ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}
