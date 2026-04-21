#!/usr/bin/env node

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

// --- Paths ---

const DATA_DIR = join(homedir(), '.local', 'share', 'ai-shell');
const HISTORY_FILE = join(DATA_DIR, 'history.jsonl');
const CONFIG_PATH = join(homedir(), '.config', 'ai-shell', 'config.json');

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

// --- Providers ---

const PROVIDERS = {
  anthropic: {
    defaultModel: 'claude-sonnet-4-6',
    envKey: 'ANTHROPIC_API_KEY',
    call: callAnthropic,
  },
  openai: {
    defaultModel: 'gpt-5.4-mini',
    envKey: 'OPENAI_API_KEY',
    call: callOpenAI,
  },
  gemini: {
    defaultModel: 'gemini-3-flash-preview',
    envKey: 'GEMINI_API_KEY',
    call: callGemini,
  },
};

// --- Config ---

function loadConfig() {
  let fileConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      process.stderr.write(`\x1b[33mWarning: failed to parse ${CONFIG_PATH}: ${err.message}\x1b[0m\n`);
    }
  }

  // Determine provider: explicit setting wins, else auto-detect from env vars
  let provider = fileConfig.provider || process.env.AI_SHELL_PROVIDER;
  if (!provider) {
    for (const [name, spec] of Object.entries(PROVIDERS)) {
      if (process.env[spec.envKey]) { provider = name; break; }
    }
    provider = provider || 'anthropic';
  }

  const spec = PROVIDERS[provider];
  if (!spec) {
    process.stderr.write(`\x1b[31mError: unknown provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(', ')}\x1b[0m\n`);
    process.exit(1);
  }

  return {
    provider,
    spec,
    model: fileConfig.model || process.env.AI_SHELL_MODEL || spec.defaultModel,
    apiKey: fileConfig.apiKey || process.env[spec.envKey],
    systemPrompt: fileConfig.systemPrompt || null,
  };
}

function printSetupHelp(provider) {
  process.stderr.write(`\x1b[31mNo API key found for provider "${provider}".\x1b[0m\n\n`);
  process.stderr.write('Set one of these environment variables to get started:\n\n');
  process.stderr.write('  Anthropic:  export ANTHROPIC_API_KEY=sk-ant-...     (https://console.anthropic.com/)\n');
  process.stderr.write('  OpenAI:     export OPENAI_API_KEY=sk-...            (https://platform.openai.com/api-keys)\n');
  process.stderr.write('  Gemini:     export GEMINI_API_KEY=...               (https://aistudio.google.com/apikey)\n\n');
  process.stderr.write(`Or create ${CONFIG_PATH}:\n\n`);
  process.stderr.write('  {\n');
  process.stderr.write('    "provider": "anthropic",\n');
  process.stderr.write('    "apiKey": "sk-ant-...",\n');
  process.stderr.write('    "model": "claude-sonnet-4-6"\n');
  process.stderr.write('  }\n');
}

// --- History ---

function readHistory() {
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    return readFileSync(HISTORY_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function appendHistory(entry) {
  ensureDataDir();
  appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
}

function getLastThread() {
  const history = readHistory();
  if (history.length === 0) return [];

  // Walk backwards from the end, collecting entries until we hit a "new" thread start
  const thread = [];
  for (let i = history.length - 1; i >= 0; i--) {
    thread.unshift(history[i]);
    if (history[i].newThread) break;
  }
  // Cap at 10 turns
  return thread.slice(-10);
}

// --- System context ---

function getSystemContext() {
  let os = 'unknown';
  try { os = execSync('uname -s', { encoding: 'utf-8' }).trim(); } catch {}
  const cwd = process.cwd();
  const shell = process.env.SHELL || 'zsh';
  return { os, cwd, shell };
}

function buildSystemPrompt(config) {
  if (config.systemPrompt) return config.systemPrompt;
  const ctx = getSystemContext();
  return `You are a shell command generator. The user describes what they want to do in natural language, and you return the shell command to do it.

Environment:
- OS: ${ctx.os}
- Shell: ${ctx.shell}
- Working directory: ${ctx.cwd}

Respond with EXACTLY this format:

COMMAND: <the shell command>
EXPLANATION: <brief explanation of what it does>

Rules:
- Output exactly ONE command (use && or | to chain if needed)
- The command must be valid for the user's shell
- Prefer common CLI tools
- Do not wrap the command in backticks or code fences
- If you need clarification, respond with: CLARIFY: <your question>
- For multi-line commands (loops, etc.), join them on one line where possible`;
}

// --- Build messages from thread context ---

function buildMessages(query, thread, lastExitCode) {
  const messages = [];

  for (const entry of thread) {
    messages.push({ role: 'user', content: entry.query });
    if (entry.command) {
      let assistantMsg = `COMMAND: ${entry.command}`;
      if (entry.explanation) assistantMsg += `\nEXPLANATION: ${entry.explanation}`;
      messages.push({ role: 'assistant', content: assistantMsg });
    }
  }

  // Build the follow-up message with exit code context
  let userMsg = query;
  if (lastExitCode !== null && lastExitCode !== undefined && lastExitCode !== '0' && lastExitCode !== 0) {
    userMsg = `The previous command exited with code ${lastExitCode}.\n\n${query}`;
  }
  messages.push({ role: 'user', content: userMsg });

  return messages;
}

// --- SSE streaming ---
// Reads an SSE response, calls extractDelta(event) on each parsed JSON event,
// writes any returned text chunk to stderr, and returns the concatenated text.

async function streamSSE(resp, extractDelta) {
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API error ${resp.status}: ${body}`);
  }

  let fullText = '';
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;

      try {
        const event = JSON.parse(data);
        const text = extractDelta(event);
        if (text) {
          fullText += text;
          process.stderr.write(text);
        }
      } catch {}
    }
  }

  process.stderr.write('\n\n');
  return fullText;
}

// --- Anthropic ---

async function callAnthropic(messages, config) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1024,
      system: buildSystemPrompt(config),
      stream: true,
      messages,
    }),
  });

  return streamSSE(resp, event =>
    event.type === 'content_block_delta' ? event.delta?.text : null
  );
}

// --- OpenAI ---

async function callOpenAI(messages, config) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1024,
      stream: true,
      messages: [
        { role: 'system', content: buildSystemPrompt(config) },
        ...messages,
      ],
    }),
  });

  return streamSSE(resp, event =>
    event.choices?.[0]?.delta?.content
  );
}

// --- Gemini ---

async function callGemini(messages, config) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: buildSystemPrompt(config) }] },
      contents,
      generationConfig: { maxOutputTokens: 1024 },
    }),
  });

  return streamSSE(resp, event =>
    event.candidates?.[0]?.content?.parts?.[0]?.text
  );
}

// --- Response parsing ---

function parseResponse(text) {
  const commandMatch = text.match(/COMMAND:\s*(.+?)(?:\n|$)/s);
  const explanationMatch = text.match(/EXPLANATION:\s*(.+?)(?:\n|$)/s);
  const clarifyMatch = text.match(/CLARIFY:\s*(.+?)(?:\n|$)/s);

  if (clarifyMatch) {
    return { type: 'clarify', message: clarifyMatch[1].trim() };
  }

  if (commandMatch) {
    return {
      type: 'command',
      command: commandMatch[1].trim(),
      explanation: explanationMatch ? explanationMatch[1].trim() : null,
    };
  }

  // Fallback: treat entire response as command (strip markdown fences)
  const stripped = text.replace(/```[\w]*\n?/g, '').trim();
  return { type: 'command', command: stripped, explanation: null };
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stderr.write(`Usage: ai-shell [--followup] [--exit-code=N] <query>

Options:
  --followup       Continue the last conversation thread
  --exit-code=N    Exit code of the last command (auto-provided by shell wrapper)
  --help, -h       Show this help

Examples:
  ai-shell "list files sorted by size"
  ai-shell --followup "that didn't work, try a different approach"
  ai-shell --followup --exit-code=1 "fix that"

Providers (auto-detected from whichever env var is set):
  anthropic   ANTHROPIC_API_KEY   default model: claude-sonnet-4-6
  openai      OPENAI_API_KEY      default model: gpt-5.4-mini
  gemini      GEMINI_API_KEY      default model: gemini-3-flash-preview

Overrides:
  AI_SHELL_PROVIDER   Force a specific provider (anthropic | openai | gemini)
  AI_SHELL_MODEL      Override the model name

Config file: ~/.config/ai-shell/config.json
History:     ~/.local/share/ai-shell/history.jsonl
`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const config = loadConfig();

  if (!config.apiKey) {
    printSetupHelp(config.provider);
    process.exit(1);
  }

  // Parse flags
  let followup = false;
  let lastExitCode = null;
  const queryParts = [];

  for (const arg of args) {
    if (arg === '--followup') {
      followup = true;
    } else if (arg.startsWith('--exit-code=')) {
      lastExitCode = arg.split('=')[1];
    } else {
      queryParts.push(arg);
    }
  }

  const query = queryParts.join(' ');
  if (!query) {
    process.stderr.write('Error: No query provided.\n');
    process.exit(1);
  }

  // Build message history
  let messages;
  if (followup) {
    const thread = getLastThread();
    messages = buildMessages(query, thread, lastExitCode);
  } else {
    messages = [{ role: 'user', content: query }];
  }

  process.stderr.write('\x1b[2m'); // dim

  let fullText;
  try {
    fullText = await config.spec.call(messages, config);
  } catch (err) {
    process.stderr.write(`\x1b[0m\x1b[31mError: ${err.message}\x1b[0m\n`);
    process.exit(1);
  }

  process.stderr.write('\x1b[0m'); // reset

  const result = parseResponse(fullText);

  if (result.type === 'clarify') {
    process.stderr.write(`\x1b[33m? ${result.message}\x1b[0m\n`);
    // Save clarify to history so follow-up has context
    appendHistory({
      timestamp: Date.now(),
      newThread: !followup,
      query,
      command: null,
      explanation: null,
      clarify: result.message,
    });
    process.exit(2);
  }

  // Only show the clean summary (the streaming already showed the raw text)
  process.stderr.write(`\x1b[32m→ ${result.command}\x1b[0m\n`);

  // Save to history
  appendHistory({
    timestamp: Date.now(),
    newThread: !followup,
    query,
    command: result.command,
    explanation: result.explanation,
  });

  // stdout: only the command (captured by shell wrapper)
  process.stdout.write(result.command);
}

main();
