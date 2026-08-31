import fs from 'node:fs';

const MAX_TURN_CHARS = 4000;
const MAX_TOTAL_CHARS = 24000;
const ARTEFACT = /^\s*<(local-command-caveat|command-name|command-message|command-args|command-stdout)\b/;

function blockText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  switch (block.type) {
    case 'text':
      return block.text || '';
    case 'thinking':
      return '';
    case 'tool_use':
      return `[used ${block.name}]`;
    case 'tool_result':
      return '';
    default:
      return '';
  }
}

function messageText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(blockText).filter(Boolean).join('\n').trim();
}

function clamp(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated]`;
}

/**
 * Read Claude Code transcript turns appended since `fromLine`.
 * Returns the turns plus the new cursor, so each Codex turn only ever receives
 * the Claude-side conversation it has not already seen.
 */
export function readTurnsSince(transcriptPath, fromLine = 0) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return { turns: [], cursor: fromLine };
  }

  const turns = [];
  let cursor = fromLine;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    cursor = i + 1;
    if (i < fromLine) continue;

    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.isSidechain) continue;
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;

    const text = messageText(entry.message);
    if (!text) continue;
    // Hook stdout from a previous turn re-enters the transcript as a user turn.
    if (text.startsWith('<switchboard')) continue;
    // So do Claude Code's own UI artefacts: slash-command echoes and the caveat
    // it prepends to them. Neither is anything the other agent should read.
    if (ARTEFACT.test(text)) continue;

    turns.push({ role: entry.type, text: clamp(text, MAX_TURN_CHARS) });
  }

  return { turns, cursor };
}

/**
 * Render turns as a briefing block for the agent taking the next turn.
 * `currentPrompt` is dropped if the transcript already flushed it, so the
 * receiving agent never sees the live prompt twice. `assistantLabel` names who
 * wrote the assistant turns — the briefing goes both ways now.
 */
export function renderBriefing(turns, currentPrompt, { assistantLabel = 'Claude' } = {}) {
  const usable = turns.filter((t) => !(t.role === 'user' && t.text.trim() === (currentPrompt || '').trim()));
  if (!usable.length) return '';

  const rendered = usable
    .map((t) => `${t.role === 'user' ? 'User' : assistantLabel}: ${t.text}`)
    .join('\n\n');

  const body = rendered.length > MAX_TOTAL_CHARS
    ? `… [earlier turns omitted]\n\n${rendered.slice(-MAX_TOTAL_CHARS)}`
    : rendered;

  return body;
}
