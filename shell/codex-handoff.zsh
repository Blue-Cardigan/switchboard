# switchboard: hand a conversation between Codex and Claude Code in place.
#
#   in Codex:       !cc    → this terminal comes back as Claude Code
#   in Claude Code: !cx    → this terminal comes back as Codex
#
# This file wraps `codex` and `claude` so that when one of them exits and a
# handoff is staged for this terminal, the other one opens on the same
# conversation. On every other path the wrapper returns the real command's exit
# code untouched. Remove it by deleting the `source` line in ~/.zshrc.
#
# Installed by install.sh; sourced from ~/.zshrc.

export SWITCHBOARD_WRAPPER=1

# Locate the checkout this file belongs to, so the wrapper keeps working
# wherever the repo was cloned. %x is the file being sourced; :A resolves the
# symlink install.sh leaves in ~/.config/switchboard.
if [[ -z "$SWITCHBOARD_HOME" ]]; then
  SWITCHBOARD_RC="${${(%):-%x}:A}"
  SWITCHBOARD_HOME="${SWITCHBOARD_RC:h:h}"
  [[ -f "$SWITCHBOARD_HOME/scripts/pending.mjs" ]] ||
    SWITCHBOARD_HOME="$HOME/.claude/skills/switchboard"
  export SWITCHBOARD_HOME SWITCHBOARD_RC
fi

_switchboard_claim() {
  local want="$1" staged target id dir tty
  tty=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')
  [[ -n "$tty" && "$tty" != '??' ]] || tty="${TTY:-$(tty 2>/dev/null)}"
  staged=$(node "$SWITCHBOARD_HOME/scripts/pending.mjs" claim "$tty" "$want" 2>/dev/null) || return 1
  [[ -n "$staged" ]] || return 1
  target="${staged%%$'\t'*}"; staged="${staged#*$'\t'}"
  id="${staged%%$'\t'*}"; dir="${staged#*$'\t'}"
  [[ -n "$id" && -d "$dir" ]] || return 1
  cd "$dir" || return 1
  if [[ "$target" == "codex" ]]; then
    print -P "%F{cyan}switchboard%f resuming this conversation in Codex…"
    exec codex resume "$id"
  fi
  print -P "%F{cyan}switchboard%f resuming this conversation in Claude Code…"
  exec claude --resume "$id"
}

# Some environments (Claude Code's own bash tool, for one) replay captured shell
# functions selectively and drop the underscore-prefixed helper while keeping
# the wrappers below. Reload our definitions rather than failing with
# "command not found"; if that is impossible, pass through untouched.
_switchboard_ready() {
  typeset -f _switchboard_claim >/dev/null 2>&1 && return 0
  local rc="${SWITCHBOARD_RC:-$HOME/.config/switchboard/codex-handoff.zsh}"
  [[ -r "$rc" ]] && source "$rc"
  typeset -f _switchboard_claim >/dev/null 2>&1
}

codex() {
  command codex "$@"
  local rc=$?
  _switchboard_ready 2>/dev/null || return $rc
  _switchboard_claim claude || return $rc
}

claude() {
  command claude "$@"
  local rc=$?
  _switchboard_ready 2>/dev/null || return $rc
  _switchboard_claim codex || return $rc
}
