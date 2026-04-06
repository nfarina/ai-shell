# ai-shell: AI-powered shell command generator
# Source this file in your ~/.zshrc:
#   source /Users/nick/Code/ai-shell/ai-shell.plugin.zsh

AI_SHELL_BIN="${0:A:h}/ai-shell.mjs"

# Primary interface: ai "your question"
# The resulting command is placed on your editing buffer via print -z,
# so you can edit it and it enters your shell history when you press Enter.
function ai() {
  if [[ -z "$*" ]]; then
    echo "Usage: ai <natural language description>" >&2
    echo "Example: ai list files sorted by size" >&2
    return 1
  fi

  local cmd
  cmd=$("$AI_SHELL_BIN" "$*")
  local rc=$?

  if [[ $rc -ne 0 ]]; then
    return $rc
  fi

  if [[ -n "$cmd" ]]; then
    print -z "$cmd"
  fi
}

# ZLE widget: press Alt+A to open an inline AI prompt.
# The resulting command is placed directly in your BUFFER.
function _ai_shell_widget() {
  local query

  zle -I  # invalidate display
  echo -n "ai> " > /dev/tty
  read -r query < /dev/tty

  if [[ -z "$query" ]]; then
    zle redisplay
    return
  fi

  local saved="$BUFFER"
  BUFFER="# thinking..."
  zle redisplay

  local cmd
  cmd=$("$AI_SHELL_BIN" "$query" 2>/dev/tty)

  if [[ -n "$cmd" ]]; then
    BUFFER="$cmd"
    CURSOR=${#BUFFER}
  else
    BUFFER="$saved"
    CURSOR=${#BUFFER}
  fi

  zle redisplay
}

zle -N _ai_shell_widget
bindkey '^[a' _ai_shell_widget  # Alt+A
