# Sourced by bin/cc and bin/cx. Claims the handoff staged against this terminal
# and replaces this process with the agent it names.
#
# This is the path for a terminal whose shell predates the switchboard wrapper
# (or never sourced it): nothing is waiting to claim the handoff when the agent
# exits, so the user finishes it by typing the same command at the prompt.
_switchboard_tty() {
  local t
  [[ -n "$SWITCHBOARD_TTY" ]] && { print -r -- "$SWITCHBOARD_TTY"; return 0; }
  t=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')
  [[ -n "$t" && "$t" != '??' ]] && { print -r -- "${t#/dev/}"; return 0; }
  print -r -- "${TTY:-$(tty 2>/dev/null)}"
}

_switchboard_staged() {
  node "$SB_ROOT/scripts/pending.mjs" peek "$(_switchboard_tty)" 2>/dev/null
}

_switchboard_finish() {
  local staged target id dir argv tty
  tty=$(_switchboard_tty)
  staged=$(node "$SB_ROOT/scripts/pending.mjs" claim "$tty" --any-age 2>/dev/null)
  if [[ -z "$staged" ]]; then
    print -u2 "switchboard: nothing staged for $tty."
    print -u2 "Run !cc inside Codex, or !cx inside Claude Code, to stage a handoff first."
    return 1
  fi
  target="${staged%%$'\t'*}"; staged="${staged#*$'\t'}"
  id="${staged%%$'\t'*}"; staged="${staged#*$'\t'}"
  dir="${staged%%$'\t'*}"; argv="${staged#*$'\t'}"
  if [[ -z "$id" || ! -d "$dir" ]]; then
    print -u2 "switchboard: staged entry for $tty was unusable ($id / $dir)."
    return 1
  fi
  # The agent being left was killed, and neither Codex nor anything else
  # restores the terminal on a signal: raw mode, mouse tracking, focus reports
  # and the kitty keyboard protocol stay on, so every keypress and mouse move
  # arrives as an escape code. Put the terminal back and drop what queued up
  # meanwhile, so the next agent starts clean.
  print -rn -- $'\e[<10u\e[>4m\e[?1000l\e[?1002l\e[?1003l\e[?1006l\e[?1004l\e[?2004l\e[?2026l\e[?1049l\e[?25h' 2>/dev/null
  stty sane 2>/dev/null
  local _sb_n=0 _sb_junk
  while (( _sb_n++ < 4096 )) && read -s -t 0.02 -k 1 _sb_junk 2>/dev/null; do :; done
  cd "$dir" || return 1
  print -P "%F{cyan}switchboard%f resuming this conversation in ${target}…"
  # The harness adapter names the command; older staged entries predate that
  # field, so fall back to the two switchboard always knew.
  if [[ -n "$argv" && "$argv" != "$dir" ]]; then
    exec ${=argv}
  elif [[ "$target" == codex ]]; then
    exec codex resume "$id"
  elif [[ "$target" == claude ]]; then
    exec claude --resume "$id"
  else
    print -u2 "switchboard: staged entry names harness '$target', which this install does not know."
    return 1
  fi
}
