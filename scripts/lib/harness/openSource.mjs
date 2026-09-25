// The open-source coding agents, as one table.
//
// Each entry is the same four facts: what the binary is called, how to install
// it, how to start it on a prompt, and how to reopen a session by id. Adding
// the next agent is those four lines — which is the point, because there are
// dozens and they change faster than any one of them can be hand-written.
//
// `launch` returns the shell line that opens the harness on a staged seed. The
// seed is a file so the transcript never has to survive a command line, and it
// is read at the last moment, by the shell, in the terminal the user is in.
import { shq } from '../seed.mjs';
import { seededHarness } from './seeded.mjs';

const SPECS = [
  {
    id: 'opencode',
    label: 'opencode',
    bin: 'opencode',
    install: 'curl -fsSL https://opencode.ai/install | bash',
    docs: 'https://opencode.ai/docs/cli/',
    launch: ({ seed }) => `exec opencode --prompt "$(cat ${shq(seed)})"`,
    resumeArgv: (id) => ['opencode', '--session', id],
    note: 'opencode export/import move a whole session as JSON — the better route once that format is pinned to a version.',
  },
  {
    id: 'goose',
    label: 'goose',
    bin: 'goose',
    install: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash',
    docs: 'https://block.github.io/goose/docs/guides/goose-cli-commands',
    // The closest fit in the field: goose takes the transcript as an
    // instruction file, stays interactive afterwards, and names the session so
    // it can be reopened.
    launch: ({ seed, id }) => (
      `exec goose run --instructions ${shq(seed)} --interactive --name switchboard-${id.slice(0, 8)}`
    ),
    resumeArgv: (id) => ['goose', 'session', '--resume', '--name', id],
  },
  {
    id: 'crush',
    label: 'Crush',
    bin: 'crush',
    install: 'brew install charmbracelet/tap/crush',
    docs: 'https://github.com/charmbracelet/crush',
    // Crush's TUI has no opening-prompt flag, so the seed goes in through the
    // non-interactive path and the TUI opens on the session it just created.
    launch: ({ seed }) => `crush run --quiet "$(cat ${shq(seed)})" >/dev/null && exec crush --continue`,
    resumeArgv: (id) => ['crush', '--session', id],
  },
  {
    id: 'aider',
    label: 'Aider',
    bin: 'aider',
    install: 'python -m pip install aider-install && aider-install',
    docs: 'https://aider.chat/docs/config/options.html',
    // Aider answers a --message-file and exits, so the handoff is two steps:
    // read the transcript, then reopen on the history it just wrote.
    launch: ({ seed }) => `aider --message-file ${shq(seed)} && exec aider --restore-chat-history`,
    resumeArgv: null,
    note: 'aider keeps the thread in .aider.chat.history.md inside the repo, not in a session store.',
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    bin: 'qwen',
    install: 'npm install -g @qwen-code/qwen-code@latest',
    docs: 'https://github.com/QwenLM/qwen-code',
    // A Gemini CLI fork, so it inherits Gemini's flags — including the
    // interactive prompt switchboard uses for Antigravity.
    launch: ({ seed }) => `exec qwen -i "$(cat ${shq(seed)})"`,
    resumeArgv: null,
  },
];

export default SPECS.map(seededHarness);
