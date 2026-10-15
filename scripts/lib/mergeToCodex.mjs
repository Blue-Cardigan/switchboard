import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './state.mjs';
import { AppServer, LEDGERS, codexHome as codexRoot } from './toCodex.mjs';
import { claudeEntries, readClaudeChain } from './claudeToEntries.mjs';
import { entriesToRolloutRows, nextOrdinal } from './codexWriter.mjs';
import { claudeLivePids, fitTurns, readMerged } from './mergeBack.mjs';
import { listSessions } from './codexRollout.mjs';
import { rolloutMeta } from './codexToClaude.mjs';

const EXPORTED = path.join(ROOT, 'exported.json');
const HEADER = '[Continued in Claude Code]\n\nAfter this point the conversation moved to Claude Code. The assistant turns below were written by Claude, not by you. Treat them as established context and honour any commitments in them, but never describe that work as something you did. Claude\'s tool calls appear as commands and file changes with their recorded output (outputs may be truncated). Continue the work from here.';

function readExported() {
  try { return JSON.parse(fs.readFileSync(EXPORTED, 'utf8')); } catch { return {}; }
}

export function saveExported(transcriptFile, record) {
  const all = readExported();
  all[transcriptFile] = record;
  fs.mkdirSync(ROOT, { recursive: true });
  const tmp = `${EXPORTED}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
  fs.renameSync(tmp, EXPORTED);
}

export function codexHome(transcriptFile) {
  const previous = readExported()[transcriptFile];
  if (previous) return { threadId: previous.threadId, rollout: previous.rollout, afterUuid: previous.lastUuid };
  for (const [rollout, entry] of Object.entries(readMerged())) {
    if (entry.transcript === transcriptFile) return { threadId: entry.threadId, rollout, afterUuid: null, afterMs: null, afterSwitchboard: true };
  }
  const canonical = fs.realpathSync(transcriptFile);
  let best = null;
  for (const keys of LEDGERS) {
    let ledger;
    try { ledger = JSON.parse(fs.readFileSync(path.join(codexRoot(), keys.file), 'utf8')); } catch { continue; }
    for (const record of Array.isArray(ledger?.records) ? ledger.records : []) {
      if (record?.[keys.source] !== canonical || typeof record[keys.thread] !== 'string') continue;
      const at = Number(record[keys.at] || 0) * (keys.at === 'imported_at' ? 1000 : 1);
      if (!best || at > best.at) best = { threadId: record[keys.thread], at };
    }
  }
  if (!best) return null;
  const session = listSessions({ limit: Infinity }).find((s) => s.sessionId === best.threadId || s.threadId === best.threadId);
  return session ? { threadId: best.threadId, rollout: session.file, afterMs: best.at } : null;
}

async function withServer(cwd, factory, action) {
  const server = factory(cwd);
  try {
    await server.start();
    await server.request('initialize', { clientInfo: { name: 'switchboard', title: 'Switchboard', version: '0.1.0' } });
    server.notify('initialized', {});
    return await action(server);
  } finally {
    await server.stop();
    // The writer lock is only released once the app-server has actually exited.
    if (server.exited) await server.exited;
  }
}

/** Append only new Claude work, refusing any Codex thread held by a live writer. */
export async function mergeToCodex(transcriptFile, { apply = false, budget = 200000, requireIdle = true, server = (cwd) => new AppServer(cwd) } = {}) {
  const home = codexHome(transcriptFile);
  if (!home) return { status: 'no-home' };
  const { threadId, rollout } = home;
  const result = { threadId };
  // Reading is safe while Claude runs; idleness only matters to a caller that
  // wants a settled conversation. The usage-limit handoff reads a session that
  // may still be registered as busy.
  if (requireIdle && claudeLivePids(path.basename(transcriptFile, '.jsonl')).busy?.length) return { ...result, status: 'claude-busy' };
  let afterUuid = home.afterUuid;
  if (home.afterSwitchboard) {
    const { chain, written } = readClaudeChain(transcriptFile);
    afterUuid = chain.findLast((r) => written.has(r.uuid))?.uuid ?? null;
  }
  // A cursor that no longer resolves (the rows were rebuilt by --rerender) must not
  // silently restart from the beginning: that would re-export the whole conversation.
  if (afterUuid && !readClaudeChain(transcriptFile).chain.some((r) => r.uuid === afterUuid)) {
    return { ...result, status: 'cursor-lost' };
  }
  const { entries, lastUuid, title } = claudeEntries(transcriptFile, { afterUuid, afterMs: home.afterMs });
  const save = () => saveExported(transcriptFile, { threadId, rollout, lastUuid, at: Date.now() });
  if (!entries.length) {
    if (apply) save();
    return { ...result, status: 'up-to-date', turns: 0 };
  }
  const fitted = fitTurns(entries, threadId, budget);
  const counts = { turns: entries.length, dropped: fitted.dropped };
  if (!apply) return { ...result, ...counts, status: 'ready' };
  const cwd = rolloutMeta(rollout).cwd || process.cwd();
  try {
    await withServer(cwd, server, (app) => app.request('thread/resume', { threadId }));
  } catch (error) {
    return { ...result, status: /active writer/i.test(error.message) ? 'codex-open' : 'error',
      ...(/active writer/i.test(error.message) ? {} : { error: error.message }) };
  }

  const backup = path.join(ROOT, 'backups', `${threadId}.${Date.now()}.jsonl`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(rollout, backup);
  try {
    const rows = entriesToRolloutRows(fitted.turns, { threadId, cwd, startOrdinal: nextOrdinal(rollout), header: HEADER });
    const fd = fs.openSync(rollout, 'r');
    const tail = Buffer.alloc(1);
    let size;
    try {
      size = fs.fstatSync(fd).size;
      if (size) fs.readSync(fd, tail, 0, 1, size - 1);
    } finally { fs.closeSync(fd); }
    fs.appendFileSync(rollout, `${size && tail[0] !== 10 ? '\n' : ''}${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    await withServer(cwd, server, async (app) => {
      const resumed = await app.request('thread/resume', { threadId });
      if (!resumed?.thread?.name && title) await app.request('thread/name/set', { threadId, name: title });
      const listed = await app.request('thread/turns/list', { threadId });
      const turns = listed?.data || listed?.turns || [];
      if (!turns.at(-1)?.id?.startsWith('sb-claude-')) throw new Error('projection failed');
    });
  } catch {
    fs.copyFileSync(backup, rollout);
    return { ...result, status: 'error', error: 'projection failed' };
  }
  save();
  return { ...result, ...counts, status: 'merged', backup };
}
