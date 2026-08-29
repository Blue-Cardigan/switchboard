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
  local staged target id dir tty
  tty=$(_switchboard_tty)
  staged=$(node "$SB_ROOT/scripts/pending.mjs" claim "$tty" --any-age 2>/dev/null)
  if [[ -z "$staged" ]]; then
    print -u2 "switchboard: nothing staged for $tty."
    print -u2 "Run !cc inside Codex, or !cx inside Claude Code, to stage a handoff first."
    return 1
  fi
  target="${staged%%$'\t'*}"; staged="${staged#*$'\t'}"
  id="${staged%%$'\t'*}"; dir="${staged#*$'\t'}"
  if [[ -z "$id" || ! -d "$dir" ]]; then
    print -u2 "switchboard: staged entry for $tty was unusable ($id / $dir)."
    return 1
  fi
  cd "$dir" || return 1
  if [[ "$target" == codex ]]; then
    print -P "%F{cyan}switchboard%f resuming this conversation in Codex…"
    exec codex resume "$id"
  fi
  print -P "%F{cyan}switchboard%f resuming this conversation in Claude Code…"
  exec claude --resume "$id"
}
