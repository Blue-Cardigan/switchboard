// Run one Claude Code turn headlessly — the mirror of codex.mjs, used by the
// Codex-side router when a Codex session hands its turns to Claude.
import { spawn } from 'node:child_process';

export function buildArgs({ sessionId, prompt, model, permissionMode, addDirs = [] }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (sessionId) args.push('--resume', sessionId);
  if (model) args.push('--model', model);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  for (const dir of addDirs) args.push('--add-dir', dir);
  args.push(prompt);
  return args;
}

function summariseBlock(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'tool_use') {
    const input = block.input || {};
    const detail = input.command || input.file_path || input.pattern || input.path || '';
    return `> ${block.name}${detail ? ` ${String(detail).replace(/\s+/g, ' ').slice(0, 80)}` : ''}`;
  }
  return null;
}

/**
 * Run one Claude Code turn. Progress is streamed to `onProgress` as it arrives
 * so the caller can show live activity while the hook blocks.
 */
export function runClaude(opts) {
  const {
    prompt, cwd, sessionId = null, model = null, permissionMode = null,
    addDirs = [], onProgress = () => {},
    timeoutMs = 840000, bin = process.env.SWITCHBOARD_CLAUDE_BIN || 'claude',
  } = opts;

  const args = buildArgs({ sessionId, prompt, model, permissionMode, addDirs });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        // stdin closed for the same reason as codex: a headless run with an open
        // non-TTY stdin can sit waiting for input that never comes.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Stops the router this run triggers from routing straight back.
        env: { ...process.env, SWITCHBOARD_ROUTED: '1' },
      });
    } catch (err) {
      resolve({ ok: false, error: `could not start ${bin}: ${err.message}` });
      return;
    }

    let newSessionId = sessionId;
    let stdoutTail = '';
    let stderr = '';
    let message = '';
    let assistantText = [];
    let failure = null;
    let settled = false;

    const timer = setTimeout(() => {
      failure = `Claude exceeded ${Math.round(timeoutMs / 1000)}s and was stopped.`;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutTail += chunk;
      const lines = stdoutTail.split('\n');
      stdoutTail = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }

        if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
          newSessionId = event.session_id;
          onProgress(`session ${event.session_id.slice(0, 8)}`);
        } else if (event.type === 'assistant') {
          for (const block of event.message?.content || []) {
            if (block?.type === 'text' && block.text) assistantText.push(block.text);
            const note = summariseBlock(block);
            if (note) onProgress(note);
          }
        } else if (event.type === 'result') {
          if (event.session_id) newSessionId = event.session_id;
          if (typeof event.result === 'string') message = event.result;
          if (event.is_error) failure = event.result || event.subtype || 'Claude reported an error';
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on('error', (err) => finish({ ok: false, error: err.message, sessionId: newSessionId }));

    child.on('close', (code) => {
      // No result event (killed, or an older CLI) still leaves the text it streamed.
      const reply = (message || assistantText.join('\n')).trim();

      if (failure) {
        finish({ ok: false, error: String(failure).split('\n')[0], sessionId: newSessionId, message: reply });
        return;
      }
      if (!reply) {
        const detail = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ');
        finish({
          ok: false,
          sessionId: newSessionId,
          error: `Claude exited ${code} without a reply${detail ? `: ${detail}` : '.'}`,
        });
        return;
      }
      finish({ ok: true, message: reply, sessionId: newSessionId });
    });
  });
}
