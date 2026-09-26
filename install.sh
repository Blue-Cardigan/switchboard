#!/bin/sh
# Switchboard installer. Idempotent: safe to re-run, and to run after a git pull.
#
#   ./install.sh                install
#   ./install.sh --codex-hooks  also route Codex prompts to Claude (opt-in)
#   ./install.sh --uninstall    remove everything it added
#
# What it touches, and nothing else:
#   ~/.local/bin/{cc,cx,cx2cc,sb,id}              symlinks to bin/
#   ~/.config/switchboard/codex-handoff.zsh       symlink to shell/
#   ~/.zshrc                                      one `source` line (backed up)
#   ~/.claude/skills/switchboard                  symlink for Claude commands
#   ~/.claude/settings.json                       SessionStart entry (backed up)
#   ~/.codex/hooks.json                           one entry, only with --codex-hooks
set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
MARKER='# switchboard: in-place handoff between Codex and Claude Code'
RC="$HOME/.zshrc"
WRAPPER="$HOME/.config/switchboard/codex-handoff.zsh"
SKILL="$HOME/.claude/skills/switchboard"

say() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }

# A symlink we own points inside this repo; anything else is the user's and is
# left alone rather than clobbered.
ours() { [ -L "$1" ] && case "$(readlink "$1")" in "$REPO"|"$REPO"/*) return 0 ;; esac; return 1; }

if [ "${1:-}" = "--codex-hooks" ]; then
  # Codex 0.151 reads ~/.codex/hooks.json the way Claude Code reads its own, so
  # the router works in that direction too — but that file is yours, and may
  # already hold hooks, so switchboard never edits it uninvited.
  printf 'Installing the Codex-side router...\n'
  node "$REPO/scripts/install-codex-hook.mjs" install
  cat <<'MSG'

  Codex now sends its prompts to Claude Code whenever a directory is switched
  to claude mode. Inside Codex:

    !cx2cc switch claude    Claude answers from here on
    !cx2cc switch codex     Codex takes it back
    !cx2cc switch status    which one is answering

  Codex asks you to trust a new hook the first time it runs. Nothing is routed
  until you say yes, and nothing changes for directories you never switch.
MSG
  exit 0
fi

if [ "${1:-}" = "--uninstall" ]; then
  printf 'Removing switchboard...\n'
  node "$REPO/scripts/install-codex-hook.mjs" remove 2>/dev/null || true
  node "$REPO/scripts/install-claude-hook.mjs" remove 2>/dev/null || true
  for c in cc cx cx2cc sb id; do
    if ours "$HOME/.local/bin/$c"; then rm -f "$HOME/.local/bin/$c"; say "removed ~/.local/bin/$c"; fi
  done
  if ours "$WRAPPER"; then rm -f "$WRAPPER"; say "removed $WRAPPER"; fi
  if ours "$SKILL"; then rm -f "$SKILL"; say "removed $SKILL"; fi
  if [ -f "$RC" ] && grep -qF "$MARKER" "$RC"; then
    cp "$RC" "$RC.bak-switchboard"
    grep -vF "$MARKER" "$RC" | grep -vF 'switchboard/codex-handoff.zsh' > "$RC.tmp$$"
    mv "$RC.tmp$$" "$RC"
    say "removed the source line from ~/.zshrc (backup: ~/.zshrc.bak-switchboard)"
  fi
  say "left ~/.claude/switchboard/ alone — delete it yourself if you want the staged state gone"
  printf 'Done. Open a new terminal.\n'
  exit 0
fi

printf 'Installing switchboard from %s\n' "$REPO"

command -v node >/dev/null 2>&1 || { warn "node not found — switchboard needs Node 18+"; exit 1; }
command -v zsh  >/dev/null 2>&1 || { warn "zsh not found — the in-place handoff needs zsh"; exit 1; }
command -v codex  >/dev/null 2>&1 || warn "codex not on PATH — install it before using cc"
command -v claude >/dev/null 2>&1 || warn "claude not on PATH — install it before using cx"
command -v agy >/dev/null 2>&1 || warn "agy not on PATH — install it before using sb to antigravity"
node "$REPO/scripts/install-claude-hook.mjs" install

# 1. Commands.
mkdir -p "$HOME/.local/bin"
for c in cc cx cx2cc sb id; do
  target="$HOME/.local/bin/$c"
  if [ -e "$target" ] && ! ours "$target"; then
    warn "$target already exists and is not ours — skipping (remove it and re-run)"
    continue
  fi
  ln -sfn "$REPO/bin/$c" "$target"
  say "linked ~/.local/bin/$c"
done
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) warn "~/.local/bin is not on your PATH — add it, or cc/cx will not be found" ;;
esac

# 2. Shell wrapper: the half that reopens the other agent in place.
mkdir -p "$HOME/.config/switchboard"
if [ -e "$WRAPPER" ] && ! ours "$WRAPPER"; then
  mv "$WRAPPER" "$WRAPPER.bak-$(date +%Y%m%d%H%M%S)"
  say "backed up your existing $WRAPPER"
fi
ln -sfn "$REPO/shell/codex-handoff.zsh" "$WRAPPER"
say "linked $WRAPPER"

if [ -f "$RC" ] && grep -qF 'switchboard/codex-handoff.zsh' "$RC"; then
  say "~/.zshrc already sources it"
else
  [ -f "$RC" ] && cp "$RC" "$RC.bak-switchboard"
  {
    printf '\n%s\n' "$MARKER"
    printf '%s\n' '[ -f ~/.config/switchboard/codex-handoff.zsh ] && source ~/.config/switchboard/codex-handoff.zsh'
  } >> "$RC"
  say "added the source line to ~/.zshrc (backup: ~/.zshrc.bak-switchboard)"
fi

# 3. Claude Code commands. The SessionStart hook is registered separately above.
if [ "$REPO" = "$SKILL" ] || [ "$(readlink "$SKILL" 2>/dev/null)" = "$REPO" ]; then
  say "Claude Code commands already point to this checkout"
elif [ -e "$SKILL" ]; then
  warn "$SKILL exists and is not this checkout — leaving it alone"
else
  mkdir -p "$HOME/.claude/skills"
  ln -sfn "$REPO" "$SKILL"
  say "linked $SKILL for Claude Code commands"
fi

cat <<'MSG'

Installed. Two things to know:

  * The wrapper only exists in shells started from now on. In a terminal that
    is already open, either run `source ~/.config/switchboard/codex-handoff.zsh`
    or finish any handoff by typing `cc` / `cx` at the prompt.
  * Claude Code picks the plugin up on its next session.

Then: `!cc` inside Codex, or `!cx` inside Claude Code.

Routing Codex's prompts to Claude Code needs one more opt-in step, because it
edits ~/.codex/hooks.json: run `./install.sh --codex-hooks`.
MSG
