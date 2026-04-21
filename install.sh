#!/usr/bin/env bash

set -euo pipefail

REPO_OWNER="nfarina"
REPO_NAME="ai-shell"
DEFAULT_REF="main"
INSTALL_REF="${AI_SHELL_INSTALL_REF:-$DEFAULT_REF}"
INSTALL_DIR="${AI_SHELL_DIR:-$HOME/.local/share/ai-shell}"
ZSHRC_PATH="${ZDOTDIR:-$HOME}/.zshrc"
ARCHIVE_URL="https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${INSTALL_REF}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Error: %s is required to install ai-shell.\n' "$1" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd tar
require_cmd zsh
require_cmd node

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

printf 'Installing ai-shell into %s\n' "$INSTALL_DIR"
curl -fsSL "$ARCHIVE_URL" -o "$tmp_dir/ai-shell.tar.gz"
tar -xzf "$tmp_dir/ai-shell.tar.gz" -C "$tmp_dir"

src_dir="$(find "$tmp_dir" -maxdepth 1 -type d -name "${REPO_NAME}-*" | head -n 1)"
if [[ -z "$src_dir" ]]; then
  printf 'Error: failed to unpack ai-shell archive.\n' >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
install -m 755 "$src_dir/ai-shell.mjs" "$INSTALL_DIR/ai-shell.mjs"
install -m 644 "$src_dir/ai-shell.plugin.zsh" "$INSTALL_DIR/ai-shell.plugin.zsh"
install -m 644 "$src_dir/README.md" "$INSTALL_DIR/README.md"
install -m 644 "$src_dir/VERSION" "$INSTALL_DIR/VERSION"

source_line="source \"$INSTALL_DIR/ai-shell.plugin.zsh\""
if [[ -f "$ZSHRC_PATH" ]] && grep -Fqx "$source_line" "$ZSHRC_PATH"; then
  :
else
  printf '\n%s\n' "$source_line" >> "$ZSHRC_PATH"
fi

printf '\nInstalled.\n'
printf 'Open a new shell, or run:\n'
printf '  source "%s"\n' "$ZSHRC_PATH"
printf '\nThen run:\n'
printf '  ai --setup\n'
