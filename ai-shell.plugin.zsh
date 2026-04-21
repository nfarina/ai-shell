# ai-shell: AI-powered shell command generator
# Source this file in your ~/.zshrc:
#   source /path/to/ai-shell/ai-shell.plugin.zsh

AI_SHELL_HOME="${${(%):-%N}:A:h}"
AI_SHELL_BIN="$AI_SHELL_HOME/ai-shell.mjs"

# Track the exit code of the last command (for ai! context)
__ai_shell_last_exit=0
function __ai_shell_save_exit() { __ai_shell_last_exit=$? }
precmd_functions+=(__ai_shell_save_exit)

# ai "question" — start a new thread
function ai() {
  if [[ $# -eq 0 ]]; then
    echo "Usage: ai <natural language description>" >&2
    echo "  ai --setup to configure your provider and API key" >&2
    echo "  ai --update to install the latest version" >&2
    echo "  ai! to follow up on the last thread" >&2
    echo "  OR:  alt-a to start a new thread" >&2
    echo "  AND: alt-shift-a to follow up on the last thread" >&2
    return 1
  fi

  local cmd
  cmd=$("$AI_SHELL_BIN" "$@")
  local rc=$?

  if [[ $rc -ne 0 ]]; then
    return $rc
  fi

  if [[ -n "$cmd" ]]; then
    print -z "$cmd"
  fi
}

# ai! "followup" — continue the last thread, with exit code context
function ai!() {
  if [[ -z "$*" ]]; then
    echo "Usage: ai! <followup question>" >&2
    echo "Example: ai! that gave an error, try another approach" >&2
    return 1
  fi

  local cmd
  cmd=$("$AI_SHELL_BIN" --followup --exit-code=$__ai_shell_last_exit "$*")
  local rc=$?

  if [[ $rc -ne 0 ]]; then
    return $rc
  fi

  if [[ -n "$cmd" ]]; then
    print -z "$cmd"
  fi
}

# --- ZLE Widgets ---

# Read multi-line input from /dev/tty.
# Disables bracketed paste so pasted text arrives clean.
# Input ends on: empty line (double-enter), Ctrl+D, or single line with no paste.
function __ai_shell_read_query() {
  local prompt_str="$1"
  local lines=()
  local line

  # Disable bracketed paste mode during input
  printf '\e[?2004l' > /dev/tty

  # Read the first line
  echo -n "$prompt_str" > /dev/tty
  IFS= read -r line < /dev/tty || { printf '\e[?2004h' > /dev/tty; REPLY=""; return; }
  line="${line//\$'\e[200~'/}"
  line="${line//\$'\e[201~'/}"
  [[ -n "$line" ]] && lines+=("$line")

  # Try reading more lines with a short timeout.
  # If nothing arrives within 0.1s, this was typed (not pasted) — submit immediately.
  # If paste data arrives, keep reading until empty line or timeout.
  while IFS= read -r -t 0.1 line < /dev/tty; do
    line="${line//\$'\e[200~'/}"
    line="${line//\$'\e[201~'/}"
    [[ -z "$line" ]] && break
    lines+=("$line")
  done

  # Re-enable bracketed paste mode
  printf '\e[?2004h' > /dev/tty

  REPLY="${(j:\n:)lines}"
}

# Option+A: new thread
function _ai_shell_widget() {
  zle -I
  __ai_shell_read_query "ai> "
  local query="$REPLY"

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

# Option+Shift+A: follow up on last thread
function _ai_shell_followup_widget() {
  zle -I
  __ai_shell_read_query "ai!> "
  local query="$REPLY"

  if [[ -z "$query" ]]; then
    zle redisplay
    return
  fi

  local saved="$BUFFER"
  BUFFER="# thinking..."
  zle redisplay

  local cmd
  cmd=$("$AI_SHELL_BIN" --followup --exit-code=$__ai_shell_last_exit "$query" 2>/dev/tty)

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
zle -N _ai_shell_followup_widget
bindkey '^[a' _ai_shell_widget           # Option+A
bindkey '^[A' _ai_shell_followup_widget   # Option+Shift+A
