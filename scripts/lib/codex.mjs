import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';


// `codex exec resume` accepts none of --profile, --sandbox or -C. To keep a
// resumed thread on the same model as the thread that started it, the profile's
// scalar settings are replayed as -c overrides instead.
const RESUME_SAFE_PROFILE_KEYS = new Set([
  'model',
  'model_provider',
  'model_context_window',
  'model_max_output_tokens',
  'model_reasoning_effort',
  'model_catalog_json',
  'model_verbosity',
  'approval_policy',
]);

export function profileOverrides(profile, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  if (!profile) return [];
  let toml;
  try { toml = fs.readFileSync(path.join(codexHome, `${profile}.config.toml`), 'utf8'); } catch { return []; }

  const overrides = [];
  for (const line of toml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) break; // top-level scalars only; tables are out of scope
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    const [, key, value] = match;
    if (!RESUME_SAFE_PROFILE_KEYS.has(key)) continue;
    overrides.push('-c', `${key}=${value.trim()}`);
  }
  return overrides;
}

export function buildArgs({ threadId, prompt, cwd, profile, model, effort, sandbox, outFile }) {
  const args = ['exec'];
  if (threadId) args.push('resume');
  args.push('--json', '--skip-git-repo-check', '-o', outFile);

  if (threadId) {
    // cwd is applied via the spawn options because resume has no -C.
    // Explicit --model/--effort must win, so the profile does not restate them.
    const shadowed = new Set([model ? 'model' : null, effort ? 'model_reasoning_effort' : null].filter(Boolean));
    const overrides = profileOverrides(profile);
    for (let i = 0; i < overrides.length; i += 2) {
      const key = overrides[i + 1].split('=')[0];
      if (shadowed.has(key)) continue;
      args.push(overrides[i], overrides[i + 1]);
    }
  } else {
    args.push('-C', cwd);
    if (profile) args.push('--profile', profile);
    if (sandbox) args.push('--sandbox', sandbox);
  }

  if (model) args.push('--model', model);
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);

  if (threadId) args.push(threadId);
  args.push(prompt);
  return args;
}

function summariseItem(item) {
  if (!item || typeof item !== 'object') return null;
  switch (item.item_type || item.type) {
    case 'command_execution': {
      const cmd = (item.command || '').replace(/\s+/g, ' ').slice(0, 90);
      return cmd ? `$ ${cmd}` : null;
    }
    case 'file_change':
      return `~ ${(item.changes || []).map((c) => c.path).join(', ').slice(0, 90) || 'file change'}`;
    case 'mcp_tool_call':
      return `> ${item.server || 'mcp'}.${item.tool || 'tool'}`;
    case 'reasoning':
      return null;
    case 'agent_message':
      return null;
    default:
      return null;
  }
}

/**
 * Run one Codex turn. Progress is streamed to `onProgress` as it arrives so the
 * caller can show live activity while the hook blocks.
 */
export function runCodex(opts) {
  const {
    prompt, cwd, threadId = null, profile = null, model = null,
    effort = null, sandbox = null, onProgress = () => {},
    timeoutMs = 840000, bin = process.env.SWITCHBOARD_CODEX_BIN || 'codex',
  } = opts;

  const outFile = path.join(os.tmpdir(), `switchboard-${crypto.randomUUID()}.txt`);
  const args = buildArgs({ threadId, prompt, cwd, profile, model, effort, sandbox, outFile });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        // stdin must be closed: with an open non-TTY stdin codex blocks on
        // "Reading additional input from stdin..." forever.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      resolve({ ok: false, error: `could not start ${bin}: ${err.message}` });
      return;
    }

    let newThreadId = threadId;
    let stdoutTail = '';
    let stderr = '';
    let failure = null;
    let settled = false;

    const timer = setTimeout(() => {
      failure = `Codex exceeded ${Math.round(timeoutMs / 1000)}s and was stopped.`;
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
        if (event.type === 'thread.started' && event.thread_id) {
          newThreadId = event.thread_id;
          onProgress(`thread ${event.thread_id.slice(0, 8)}`);
        } else if (event.type === 'item.completed') {
          const note = summariseItem(event.item);
          if (note) onProgress(note);
        } else if (event.type === 'error' || event.type === 'turn.failed') {
          const message = event.message || event.error?.message || 'unknown Codex error';
          failure = String(message);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.unlinkSync(outFile); } catch { /* best effort */ }
      resolve(result);
    };

    child.on('error', (err) => finish({ ok: false, error: err.message, threadId: newThreadId }));

    child.on('close', (code) => {
      let message = '';
      try { message = fs.readFileSync(outFile, 'utf8').trim(); } catch { /* no output */ }
      // codex writes this notice to the output file when it exits before replying
      if (message === 'Reading additional input from stdin...') message = '';

      if (failure) {
        finish({ ok: false, error: prettyError(failure), threadId: newThreadId, message });
        return;
      }
      if (!message) {
        const detail = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ');
        finish({
          ok: false,
          threadId: newThreadId,
          error: `Codex exited ${code} without a reply${detail ? `: ${detail}` : '.'}`,
        });
        return;
      }
      finish({ ok: true, message, threadId: newThreadId });
    });
  });
}

// Codex wraps upstream provider errors in nested JSON; surface the readable part.
export function prettyError(raw) {
  const text = String(raw);
  try {
    const parsed = JSON.parse(text);
    const inner = parsed?.error?.message;
    if (inner) return String(inner).split('\n')[0];
  } catch { /* not JSON */ }
  return text.split('\n')[0];
}
