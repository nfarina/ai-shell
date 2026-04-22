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

# Insert a literal newline into the buffer. Bound to Shift+Enter and
# Option+Enter inside the ai> prompt so users can type multi-line queries.
function _ai_shell_insert_newline() { LBUFFER+=$'\n' }
zle -N _ai_shell_insert_newline

# Show an "ai> " prompt using zle's line editor, read a query, then run the
# binary with the query plus any extra args, and load the generated command
# onto a fresh shell prompt below the streamed output.
#
# Display dance, because zle owns whatever it drew:
#   The ai> prompt uses PREDISPLAY="\nai> " so the display is 2 rows tall.
#   When we later redraw a 1-row prompt (PS1 + generated command), zle diffs
#   the heights and clears the trailing row of the old display — which
#   happens to be the user's "ai> query" line. The external binary output
#   on rows below isn't in zle's display, so it's safe.
#   Fix: before running the binary we (a) shrink zle's display to 1 row so
#   it lets go of the ai> row, then (b) re-emit "ai> query" as plain tty
#   text — real scrollback, immune to any later zle redraw.
function __ai_shell_prompt() {
  local prompt_str="$1"; shift
  local saved_buffer="$BUFFER"
  local saved_cursor="$CURSOR"
  local saved_predisplay="$PREDISPLAY"

  # Clone the user's current keymap and layer on multi-line Enter bindings
  # scoped to just the ai> prompt.
  bindkey -N ai-shell-prompt main
  bindkey -M ai-shell-prompt '^[^M'     _ai_shell_insert_newline   # Opt/Alt+Enter
  bindkey -M ai-shell-prompt '^[[13;2u' _ai_shell_insert_newline   # Shift+Enter (CSI-u)
  bindkey -M ai-shell-prompt '^[[13;3u' _ai_shell_insert_newline   # Opt/Alt+Enter (CSI-u)

  BUFFER=""
  CURSOR=0
  PREDISPLAY="$prompt_str"
  zle -R
  zle recursive-edit -K ai-shell-prompt
  local ret=$?
  local query="$BUFFER"

  if [[ $ret -ne 0 || -z "$query" ]]; then
    BUFFER="$saved_buffer"
    CURSOR="$saved_cursor"
    PREDISPLAY="$saved_predisplay"
    zle reset-prompt
    return
  fi

  # (a) Shrink zle's display to 1 row (just PS1). This causes zle to clear
  # its 2nd row — fine, we're about to rewrite it.
  BUFFER=""
  CURSOR=0
  PREDISPLAY="$saved_predisplay"
  zle -R

  # (b) Re-emit "ai> query" as plain tty text so it persists as scrollback.
  # Print adds one trailing newline; combined with the \n that zle emits as
  # part of its redisplay-shrink above, that gives one blank line between
  # "ai> query" and the streamed response.
  print -r -- "${prompt_str}${query}" >/dev/tty

  # Invalidate tracking so the final reset-prompt draws fresh at the
  # current cursor (below the binary output) rather than at the old row.
  zle -I

  local cmd
  cmd=$("$AI_SHELL_BIN" "$@" "$query" 2>/dev/tty)

  if [[ -n "$cmd" ]]; then
    BUFFER="$cmd"
  else
    BUFFER="$saved_buffer"
  fi
  CURSOR=${#BUFFER}
  zle reset-prompt
}

# Option+A: new thread
function _ai_shell_widget() {
  __ai_shell_prompt $'\nai> '
}

# Option+Shift+A: follow up on last thread
function _ai_shell_followup_widget() {
  __ai_shell_prompt $'\nai!> ' --followup --exit-code=$__ai_shell_last_exit
}

zle -N _ai_shell_widget
zle -N _ai_shell_followup_widget
bindkey '^[a' _ai_shell_widget           # Option+A
bindkey '^[A' _ai_shell_followup_widget   # Option+Shift+A
