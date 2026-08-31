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

# Reloading is done inline in each wrapper below, not through a helper. Some
# environments (Claude Code's own bash tool, for one) replay captured shell
# functions selectively: they keep `codex`/`claude` and drop everything
# underscore-prefixed. A helper that is missing cannot restore itself, so the
# bootstrap has to use nothing but builtins.
# Subcommands that are not an interactive conversation. Nothing is handed over
# when one of these exits, and claiming a staged handoff there would replace a
# shell someone is using for something else — `codex exec` inside a script or
# another agent, for instance. `resume`, `fork` and a bare prompt still qualify.
codex() {
  case "$1" in
    exec|e|review|login|logout|mcp|mcp-server|app-server|remote-control|app|plugin|\
completion|update|doctor|sandbox|debug|apply|a|queue|archive|delete|unarchive|\
migrate-rollouts|cloud|exec-server|features|help|-h|--help|-V|--version)
      command codex "$@"
      return $?
      ;;
  esac
  command codex "$@"
  local rc=$?
  # A routed turn is switchboard driving Codex on the user's behalf; it owns no
  # terminal and must not claim one.
  [[ "$SWITCHBOARD_ROUTED" == 1 ]] && return $rc
  if ! typeset -f _switchboard_claim >/dev/null 2>&1; then
    _sb_rc="${SWITCHBOARD_RC:-$HOME/.config/switchboard/codex-handoff.zsh}"
    [[ -r "$_sb_rc" ]] && source "$_sb_rc"
    unset _sb_rc
  fi
  typeset -f _switchboard_claim >/dev/null 2>&1 || return $rc
  _switchboard_claim claude || return $rc
}

claude() {
  case "$1" in
    agents|auth|auto-mode|config|doctor|gateway|import|install|logs|mcp|\
migrate-installer|plugin|plugins|project|respawn|rm|setup-token|stop|kill|\
ultrareview|update|upgrade|-h|--help|--version)
      command claude "$@"
      return $?
      ;;
  esac
  # -p/--print is headless: it prints one reply and exits. It is also how
  # switchboard drives Claude from the Codex side, so it can appear anywhere in
  # the arguments and must never trigger a claim.
  local _sb_arg
  for _sb_arg in "$@"; do
    case "$_sb_arg" in
      -p|--print)
        command claude "$@"
        return $?
        ;;
    esac
  done
  command claude "$@"
  local rc=$?
  [[ "$SWITCHBOARD_ROUTED" == 1 ]] && return $rc
  if ! typeset -f _switchboard_claim >/dev/null 2>&1; then
    _sb_rc="${SWITCHBOARD_RC:-$HOME/.config/switchboard/codex-handoff.zsh}"
    [[ -r "$_sb_rc" ]] && source "$_sb_rc"
    unset _sb_rc
  fi
  typeset -f _switchboard_claim >/dev/null 2>&1 || return $rc
  _switchboard_claim codex || return $rc
}
