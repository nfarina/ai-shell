<img width="1080" height="330" alt="AIShell_cropped" src="https://github.com/user-attachments/assets/db4bbd76-0d74-42f2-adca-798fdd53be01" />

# ai-shell

A tiny zsh plugin that turns natural language into shell commands. Describe what
you want, press enter, and the command lands on your prompt — ready to review
before you run it.

Unlike other "AI in your shell" tools, this plugin puts the command to run right in your prompt, letting you edit and submit it, and _leaving it in your history_ so you can re-run it with up-arrow if you need to.

The best way to run it is using the zsh "widget" - press `option+a` then type or paste whatever you want, without worrying about escaping quotes or anything:

```
$ <type option+a>
ai> use ffmpeg to crop demo.mov keeping the top 30% vertically

COMMAND: ffmpeg -i AIShell. mov -vf "crop=iw:ih*0.3:0:0" -c:a copy demo_cropped.mov
EXPLANATION: Crops the video to keep only the top 30% vertically - full width ("iw"), 30% of height ('ih*0.3'), starting f rom the top-left corner ('0:0"). Audio is copied as-is.

$ ffmpeg -i AIShell. mov -vf "crop=iw:ih*0.3:0:0" -c:a copy demo_cropped.mov
```

You can also invoke it using the `ai` command and put your prompt as the command-line argument:

```
$ ai list the 5 largest files in this directory
→ du -ah . | sort -rh | head -n 5
```

- **Streams** the model's thinking while it works.
- **Stays on your prompt** — you always get the chance to read and edit the
  command before hitting enter.
- **Answers questions** too — ask "what does `xargs -I` do?" and you get an
  answer instead of a command.
- **Follow-ups** with context: if a command fails, ask `ai!` to fix it and the
  previous exit code and conversation history come along.
- **Multi-provider**: Anthropic, OpenAI, or Google Gemini.

## Install

Requires Node.js 18+ (for native `fetch`) and zsh.

```sh
curl -fsSL https://raw.githubusercontent.com/nfarina/ai-shell/main/install.sh | bash
```

Open a new shell, then run:

```sh
ai --setup
```

That creates `~/.config/ai-shell/config.json` for you.

## Usage

| Command             | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `ai <query>`        | Start a new thread. Result lands on your prompt.      |
| `ai! <query>`       | Follow up on the last thread (carries exit code too). |
| `ai --setup`        | Create or rewrite your config file.                   |
| `ai --update`       | Install the latest version from GitHub.               |
| `Option+A`          | Prompt for a query inline, then replace the buffer.   |
| `Option+Shift+A`    | Same, but as a follow-up on the last thread.          |

If you try `ai ...` before configuring it, ai-shell will launch the same setup
flow automatically.

Inside the `Option+A` / `Option+Shift+A` prompts you can press **Shift+Enter**
or **Option+Enter** to add a newline for multi-line queries; plain Enter submits.

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

You can also just ask questions. If your query doesn't need a command to answer,
the model will reply directly and leave your prompt empty:

```sh
$ ai what's the difference between rsync -a and rsync -r?

ANSWER: -a (archive) implies -r plus preserving symlinks, permissions, timestamps,
group, owner, and device files. -r is just recursive copy. Use -a for backups.
```

## Providers

The normal setup flow writes a config file. If you also set environment vars,
they override the config and are useful for temporary changes or CI.

| Provider    | Env override         | Default model              |
| ----------- | -------------------- | -------------------------- |
| `anthropic` | `ANTHROPIC_API_KEY`  | `claude-sonnet-4-6`        |
| `openai`    | `OPENAI_API_KEY`     | `gpt-5.4-mini`             |
| `gemini`    | `GEMINI_API_KEY`     | `gemini-3-flash-preview`   |

You can also override:

- `AI_SHELL_PROVIDER`
- `AI_SHELL_MODEL`
- `AI_SHELL_SYSTEM_PROMPT`

## Config file

Lives at `~/.config/ai-shell/config.json`:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "apiKey": "sk-ant-...",
  "systemPrompt": null
}
```

`provider`, `model`, and `apiKey` are what most users need. `systemPrompt` is
optional and replaces the built-in prompt entirely.

The API key is stored in plain text in this file. That keeps setup simple, but
it is a deliberate tradeoff.

## Updating

ai-shell checks GitHub for a newer version occasionally while you use it. If a
new version is available, it prints a reminder:

```sh
Update available: 0.1.0 -> 0.2.0. Run "ai --update".
```

Then update in place:

```sh
ai --update
```

## Where things live

- Config:   `~/.config/ai-shell/config.json`
- History:  `~/.local/share/ai-shell/history.jsonl` (one JSON object per turn)
- Update cache: `~/.local/share/ai-shell/update-check.json`

History is append-only and used for follow-up context. Delete the file to wipe
it; nothing breaks.

## How it works

`ai-shell.plugin.zsh` defines the `ai` / `ai!` functions and the Option+A key
widgets. They shell out to `ai-shell.mjs`, which makes a streaming API call to
your chosen provider using a system prompt that asks for a single command in a
strict `COMMAND: ... / EXPLANATION: ...` format. The plugin captures the
command on stdout and loads it onto your prompt with `print -z`.

No external Node dependencies — it's one file using the built-in `fetch`.
