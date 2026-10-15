import fs from 'node:fs';

const MARKER = /^\[(Continued in Codex|Imported from Codex|More turns from Codex)/;
const textOf = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n') : '';

/** Read the resumed conversation's ancestry, excluding abandoned branches. */
export function readClaudeChain(transcriptFile) {
  const rows = [];
  for (const line of fs.readFileSync(transcriptFile, 'utf8').split('\n')) {
    try { rows.push(JSON.parse(line)); } catch { /* Partial or blank row. */ }
  }
  const byId = new Map(rows.filter((r) => r?.uuid).map((r) => [r.uuid, r]));
  const chain = [];
  const seen = new Set();
  let row = rows.findLast((r) => r?.uuid && r.isSidechain !== true);
  while (row && !seen.has(row.uuid)) {
    chain.push(row);
    seen.add(row.uuid);
    row = byId.get(row.parentUuid);
  }
  chain.reverse();
  const writtenRow = (r) => r?.requestId === 'req_codex_import'
    || (r?.type === 'user' && typeof r.message?.content === 'string' && MARKER.test(r.message.content));
  const stamps = new Set(rows.filter(writtenRow).map((r) => r.timestamp).filter((s) => s != null));
  const written = new Set(chain.filter((r) => writtenRow(r) || stamps.has(r.timestamp)).map((r) => r.uuid));
  const title = rows.findLast((r) => r?.type === 'custom-title')?.customTitle ?? null;
  return { chain, written, title };
}

/** Claude messages and recorded tools in the shared harness entry shape. */
export function claudeEntries(transcriptFile, { afterUuid = null, afterMs = null } = {}) {
  const { chain, written, title } = readClaudeChain(transcriptFile);
  let start = afterUuid == null ? -1 : chain.findIndex((r) => r.uuid === afterUuid);
  if (start < 0 && afterMs != null) start = chain.findLastIndex((r) => Date.parse(r.timestamp) <= afterMs);
  const entries = [];
  const pending = new Map();
  for (const row of chain.slice(start + 1)) {
    if (written.has(row.uuid)) continue;
    const content = row.message?.content;
    if (row.type === 'user') {
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type !== 'tool_result') continue;
        const tool = pending.get(block.tool_use_id);
        if (tool) {
          tool.result = textOf(block.content).slice(0, 2000);
          tool.isError = Boolean(block.is_error);
          pending.delete(block.tool_use_id);
        }
      }
      let text = textOf(content);
      if (row.isMeta || !text || /^(<command-|<local-command|<system-reminder>)/.test(text)) continue;
      if (text.startsWith('<task-notification>')) text = text.slice(0, 1500);
      entries.push({ role: 'user', text });
    } else if (row.type === 'assistant') {
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'text' && block.text) entries.push({ role: 'assistant', text: block.text });
        else if (block?.type === 'tool_use') {
          const tool = { id: block.id, name: block.name, input: block.input || {}, result: 'No output recorded.', isError: false };
          if (entries.at(-1)?.tools) entries.at(-1).tools.push(tool);
          else entries.push({ role: 'assistant', tools: [tool] });
          pending.set(tool.id, tool);
        }
      }
    }
  }
  return { entries, lastUuid: chain.at(-1)?.uuid ?? null, title };
}
