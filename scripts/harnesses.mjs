#!/usr/bin/env node
// What switchboard knows how to talk to, and what each of them can do.
import { harnesses, host } from './lib/harness/index.mjs';

const CAPABILITIES = [
  ['read', 'read a conversation out'],
  ['write', 'be handed one'],
  ['resume', 'reopen one by id'],
  ['fork', 'duplicate one in place'],
];

const here = host();
for (const harness of Object.values(harnesses)) {
  const can = CAPABILITIES.filter(([key]) => harness.capabilities[key]).map(([, text]) => text);
  const cannot = CAPABILITIES.filter(([key]) => !harness.capabilities[key]).map(([, text]) => text);
  console.log(`${harness.id === here?.id ? '*' : ' '} ${harness.id.padEnd(8)} ${harness.label}`);
  console.log(`    can: ${can.join(', ') || 'nothing'}`);
  if (cannot.length) console.log(`    cannot: ${cannot.join(', ')}`);
}
if (here) console.log(`\n* is the harness this command is running inside.`);
