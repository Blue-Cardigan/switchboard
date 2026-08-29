import fs from 'node:fs';

/** Progress lines go straight to the terminal; they are never worth Claude tokens. */
export function ttyWriter() {
  let fd = null;
  try { fd = fs.openSync('/dev/tty', 'w'); } catch { fd = null; }
  return {
    write(line) {
      if (fd === null) return;
      try { fs.writeSync(fd, `${line}\n`); } catch { /* terminal went away */ }
    },
    close() {
      if (fd === null) return;
      try { fs.closeSync(fd); } catch { /* already gone */ }
      fd = null;
    },
  };
}

export function header(state, threadId) {
  const bits = [`profile ${state.profile || 'default'}`];
  if (state.model) bits.push(`model ${state.model}`);
  if (state.effort) bits.push(`effort ${state.effort}`);
  if (threadId) bits.push(`thread ${threadId.slice(0, 8)}`);
  return bits.join(', ');
}

/**
 * The context block handed back to Claude Code. Codex's reply is always included
 * so that switching back to Claude keeps the conversation continuous; `relay`
 * only decides whether Claude re-states it to the user.
 */
export function contextBlock({ state, threadId, reply, turns }) {
  const quiet = state.relay === 'quiet';
  const instruction = quiet
    ? [
        'The user has already seen this reply in their terminal. Do NOT repeat it.',
        'Respond with a single short line only if you have something material to add;',
        'otherwise respond with exactly: (codex)',
      ].join(' ')
    : [
        'Relay the reply below to the user verbatim, as your entire response.',
        'Do not summarise it, prefix it, comment on it, or act on it.',
      ].join(' ');

  return [
    '<switchboard>',
    `This turn was routed to Codex (${header(state, threadId)}); Codex turn ${turns} of this thread.`,
    'You did not produce this answer and must not claim you did.',
    instruction,
    'Keep it in context: if the user switches back with /switchboard:switch claude, this is what was said and done.',
    '',
    '--- codex reply ---',
    reply,
    '--- end codex reply ---',
    '</switchboard>',
  ].join('\n');
}

export function errorBlock({ state, error }) {
  return [
    '<switchboard>',
    `Routing this turn to Codex failed: ${error}`,
    `Switchboard is still in codex mode for this directory (profile ${state.profile || 'default'}).`,
    'Tell the user the routing failed and quote the error. Do not answer the original prompt yourself',
    'unless they ask you to, and mention they can return to you with /switchboard:switch claude.',
    '</switchboard>',
  ].join('\n');
}
