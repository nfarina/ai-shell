# ai-shell

A tiny zsh plugin that turns natural language into shell commands. Describe what
you want, press enter, and the command lands on your prompt — ready to review
before you run it.

```
$ ai list the 5 largest files in this directory
→ du -ah . | sort -rh | head -n 5
```

- **Streams** the model's thinking while it works.
- **Stays on your prompt** — you always get the chance to read and edit the
  command before hitting enter.
- **Follow-ups** with context: if a command fails, ask `ai!` to fix it and the
  previous exit code and conversation history come along.
- **Multi-provider**: Anthropic, OpenAI, or Google Gemini.

## Install

Requires Node.js 18+ (for native `fetch`) and zsh.

```sh
git clone https://github.com/YOUR_USERNAME/ai-shell.git ~/.ai-shell
echo 'source ~/.ai-shell/ai-shell.plugin.zsh' >> ~/.zshrc
```

Then set an API key for whichever provider you want to use:

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # https://console.anthropic.com/
# or
export OPENAI_API_KEY=sk-...          # https://platform.openai.com/api-keys
# or
export GEMINI_API_KEY=...             # https://aistudio.google.com/apikey
```

Open a new shell and you're ready.

## Usage

| Command          | What it does                                          |
| ---------------- | ----------------------------------------------------- |
| `ai <query>`     | Start a new thread. Result lands on your prompt.      |
| `ai! <query>`    | Follow up on the last thread (carries exit code too). |
| `Alt+A`          | Prompt for a query inline, then replace the buffer.   |
| `Alt+Shift+A`    | Same, but as a follow-up on the last thread.          |

### Examples

```sh
ai find all PDFs modified this week
ai compress this folder to a tarball named backup.tgz
ai show disk usage per subdirectory, sorted
```

If a command fails, follow up:

```sh
$ ai! that errored — try with sudo
```

If the model isn't sure what you mean, it'll ask a clarifying question instead
of guessing.

## Providers

The provider is auto-detected from whichever API key env var is set. To pick
one explicitly (if you have multiple keys exported) set `AI_SHELL_PROVIDER`.

| Provider    | Env var              | Default model        |
| ----------- | -------------------- | -------------------- |
| `anthropic` | `ANTHROPIC_API_KEY`  | `claude-sonnet-4-6`  |
| `openai`    | `OPENAI_API_KEY`     | `gpt-5.4-mini`          |
| `gemini`    | `GEMINI_API_KEY`     | `gemini-3-flash-preview` |

Override the model with `AI_SHELL_MODEL=...` or in the config file.

## Config file

Optional. Lives at `~/.config/ai-shell/config.json`:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "apiKey": "sk-ant-...",
  "systemPrompt": null
}
```

All fields are optional. Env vars override nothing here — config values win if
set. Set `systemPrompt` to a string to replace the built-in prompt entirely.

## Where things live

- Config:   `~/.config/ai-shell/config.json`
- History:  `~/.local/share/ai-shell/history.jsonl` (one JSON object per turn)

History is append-only and used for follow-up context. Delete the file to wipe
it; nothing breaks.

## How it works

`ai-shell.plugin.zsh` defines the `ai` / `ai!` functions and the Alt+A key
widgets. They shell out to `ai-shell.mjs`, which makes a streaming API call to
your chosen provider using a system prompt that asks for a single command in a
strict `COMMAND: ... / EXPLANATION: ...` format. The plugin captures the
command on stdout and loads it onto your prompt with `print -z`.

No external Node dependencies — it's one file using the built-in `fetch`.
