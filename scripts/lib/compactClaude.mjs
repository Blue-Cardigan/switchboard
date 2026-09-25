// Keep the conversation a receiving agent can use, rather than importing
// Claude Code's tool traffic, thinking, UI echoes and quota notices verbatim.
const TURN_LIMIT = 4000;
const CONTEXT_LIMIT = 120000;
const UI_ECHO = /^\s*<(?:local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|command-name|command-message|command-args|command-stdout)\b/i;
const LIMIT_NOTICE = /^\s*You've hit your session limit(?:\s*[·—-].*)?\s*$/i;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text')
    .map((block) => block.text || '').join('\n').trim();
}

function clipped(text) {
  return text.length > TURN_LIMIT ? `${text.slice(0, TURN_LIMIT)}\n… [turn truncated]` : text;
}

/** A stable Claude JSONL snapshot suitable for Codex's external-agent importer. */
export function compactClaudeTranscript(bytes, { maxChars = CONTEXT_LIMIT } = {}) {
  const rows = [];
  let skipped = 0;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { skipped += 1; continue; }
    if (row.isSidechain || !['user', 'assistant'].includes(row.type)) { skipped += 1; continue; }
    const text = textOf(row.message?.content).trim();
    if (!text || UI_ECHO.test(text) || LIMIT_NOTICE.test(text) || text.startsWith('<switchboard')) {
      skipped += 1;
      continue;
    }
    rows.push({ row, text: clipped(text) });
  }

  // Preserve the original request and the most recent conversation. This is
  // the same policy as the other harness adapters, but applied before Codex
  // sees the transcript so omitted material costs no context.
  if (!rows.some(({ row }) => row.type === 'user')) {
    throw new Error('Claude transcript has no user conversation to import.');
  }
  let chars = rows.reduce((sum, item) => sum + item.text.length, 0);
  let dropped = 0;
  while (chars > maxChars && rows.length > 4) {
    const index = rows[0].row.type === 'user' ? 1 : 0;
    const [removed] = rows.splice(index, 1);
    chars -= removed.text.length;
    dropped += 1;
  }

  let parentUuid = null;
  const output = rows.map(({ row, text }, index) => {
    const message = {
      role: row.type,
      content: row.type === 'user' ? text : [{ type: 'text', text }],
    };
    const next = {
      type: row.type,
      isSidechain: false,
      sessionId: row.sessionId,
      uuid: row.uuid,
      parentUuid,
      timestamp: row.timestamp,
      cwd: row.cwd,
      message,
    };
    if (index === 0 && dropped) {
      const note = `[Switchboard omitted ${dropped} older turn(s) to fit the context budget.]\n\n`;
      next.message.content = row.type === 'user'
        ? note + text
        : [{ type: 'text', text: note + text }];
    }
    parentUuid = row.uuid || null;
    return JSON.stringify(next);
  });
  return {
    bytes: Buffer.from(`${output.join('\n')}\n`),
    kept: rows.length,
    skipped,
    dropped,
  };
}
