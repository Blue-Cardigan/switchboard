#!/usr/bin/env node
// Prints where this command is running: codex | claude | shell.
// `cc`/`cx` use it to tell a handoff request apart from a claim.
import { wrapperActive } from './lib/agentContext.mjs';
import { host } from './lib/harness/index.mjs';

if (process.argv.includes('--wrapper')) {
  process.stdout.write(wrapperActive() ? 'yes\n' : 'no\n');
} else {
  process.stdout.write(`${host()?.id ?? 'shell'}\n`);
}
