import { execFileSync } from 'node:child_process';

function appleQuote(text) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

/** The shell one-liner that reopens a session, for either agent. */
export function resumeCommand(sessionId, cwd, agent = 'claude') {
  const resume = agent === 'codex' ? `codex resume ${sessionId}` : `claude --resume ${sessionId}`;
  return `cd ${shellQuote(cwd)} && ${resume}`;
}

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function osascript(script) {
  return run('osascript', ['-e', script]);
}

/**
 * Open the resumed session in a new Terminal.app window. Returns false if the
 * terminal could not be driven, so the caller can fall back to printing.
 */
export function openInTerminal(sessionId, cwd, agent = 'claude') {
  const command = appleQuote(resumeCommand(sessionId, cwd, agent));
  const script = `tell application "Terminal"\n  activate\n  do script "${command}"\nend tell`;
  return osascript(script);
}

/**
 * Put the resumed session next to the one you are in rather than replacing it:
 * a tmux split where there is a tmux, otherwise a new tab or window in whatever
 * terminal is running. Returns a short description of what it did, or null if
 * nothing here can be driven and the caller should print the command instead.
 */
export function openAlongside(sessionId, cwd, agent = 'claude') {
  const command = resumeCommand(sessionId, cwd, agent);
  const login = [process.env.SHELL || '/bin/sh', '-lc', command];

  if (process.env.TMUX) {
    if (run('tmux', ['split-window', '-h', '-c', cwd, ...login])) return 'split this tmux window';
    if (run('tmux', ['new-window', '-c', cwd, ...login])) return 'opened a new tmux window';
  }

  if (process.platform === 'darwin') {
    if (process.env.TERM_PROGRAM === 'iTerm.app') {
      const c = appleQuote(command);
      const script = 'tell application "iTerm2"\n' +
        '  if (count of windows) = 0 then\n' +
        '    set w to (create window with default profile)\n' +
        `    tell current session of w to write text "${c}"\n` +
        '  else\n' +
        '    tell current window\n' +
        '      set t to (create tab with default profile)\n' +
        `      tell current session of t to write text "${c}"\n` +
        '    end tell\n' +
        '  end if\n' +
        '  activate\n' +
        'end tell';
      if (osascript(script)) return 'opened a new iTerm tab';
    }
    if (openInTerminal(sessionId, cwd, agent)) return 'opened a new Terminal window';
  }

  for (const term of [process.env.SWITCHBOARD_TERMINAL, 'x-terminal-emulator', 'kitty', 'wezterm', 'alacritty', 'gnome-terminal']) {
    if (!term) continue;
    if (run(term, ['-e', ...login])) return `opened a new ${term} window`;
  }

  return null;
}
