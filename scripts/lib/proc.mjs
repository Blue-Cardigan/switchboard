// Who launched this process, and what is on PATH.
//
// Every adapter needs the same two answers — "am I running inside <bin>?" and
// "is <bin> installed at all?" — and the registry asks the first of them once
// per harness. One `ps` for the whole process table is cheaper than walking the
// tree a fork at a time, and the answer cannot change while we hold it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let table = null;

/** pid → { ppid, comm } for every process this user can see. */
function processTable() {
  if (table) return table;
  table = new Map();
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', maxBuffer: 8 << 20 });
    for (const line of out.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) table.set(Number(match[1]), { ppid: Number(match[2]), comm: match[3].trim() });
    }
  } catch { /* an empty table just means nothing claims to be a host */ }
  return table;
}

/** The chain of commands above this process, closest first. */
export function ancestry(startPid = process.pid, maxDepth = 12) {
  const processes = processTable();
  const chain = [];
  let pid = startPid;
  for (let i = 0; i < maxDepth; i += 1) {
    const entry = processes.get(pid);
    if (!entry || entry.ppid <= 1) break;
    const parent = processes.get(entry.ppid);
    if (!parent) break;
    chain.push({ pid: entry.ppid, comm: parent.comm });
    pid = entry.ppid;
  }
  return chain;
}

/** The pid of the nearest ancestor whose command matches, or null. */
export function findAncestor(pattern, startPid = process.pid) {
  const found = ancestry(startPid).find((entry) => pattern.test(entry.comm));
  return found ? found.pid : null;
}

/** Is this command installed? Asked before switchboard suggests running it. */
export function onPath(bin) {
  if (!bin) return false;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch { /* next */ }
  }
  return false;
}
