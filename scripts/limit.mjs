#!/usr/bin/env node
// `sb limit` — what happens when the harness you are in hits its usage limit.
//
//   sb limit                   show the current setting
//   sb limit on | off          hand the conversation on automatically, or not
//   sb limit to <harness>      always hand it to that harness
//   sb limit to recent         hand it to whichever other harness you used last here
//   sb limit start on | off    have the new session carry on by itself, or wait for you
import * as config from './lib/config.mjs';
import { harnesses, ids } from './lib/harness/index.mjs';
import { onPath } from './lib/proc.mjs';

function show(c) {
  const s = c.onLimit;
  if (!s.enabled) {
    console.log('On usage limit: do nothing (sb limit on to enable).');
    return;
  }
  const to = s.target === 'recent' ? 'the other harness used most recently in this directory' : s.target;
  console.log(`On usage limit: open this conversation in ${to}, beside the limited session,\n` +
    `  and ${s.start ? 'have it carry on straight away' : 'wait for you to prompt it'}.`);
  console.log(`  config: ${config.CONFIG_PATH}`);
}

function toggle(word, what) {
  if (word === 'on' || word === 'true') return true;
  if (word === 'off' || word === 'false') return false;
  throw new Error(`${what} takes on or off.`);
}

const c = config.load();
const [verb, value] = process.argv.slice(2);
try {
  if (!verb || verb === 'status') {
    show(c);
  } else {
    if (verb === 'on' || verb === 'off') c.onLimit.enabled = verb === 'on';
    else if (verb === 'start') c.onLimit.start = toggle(value, 'sb limit start');
    else if (verb === 'to') {
      if (!value) throw new Error(`sb limit to takes recent or a harness: ${ids().join(', ')}.`);
      if (value !== 'recent') {
        const h = harnesses[value];
        if (!h) throw new Error(`Unknown harness "${value}". Known: ${ids().join(', ')}.`);
        if (!h.capabilities.write) throw new Error(`${h.label} cannot be handed a conversation.`);
        if (h.bin && !onPath(h.bin)) console.log(`note: ${h.bin} is not installed here yet.`);
      }
      c.onLimit.target = value;
    } else throw new Error(`Unknown: sb limit ${verb}. Try on, off, to <harness|recent>, start on|off.`);
    config.save(c);
    show(c);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
