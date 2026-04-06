#!/usr/bin/env node

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
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

// --- Config ---

function loadConfig() {
  let fileConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {}
  }
  return {
    provider: fileConfig.provider || process.env.AI_SHELL_PROVIDER || 'anthropic',
    model: fileConfig.model || process.env.AI_SHELL_MODEL || 'claude-sonnet-4-6',
    apiKey: fileConfig.apiKey || process.env.ANTHROPIC_API_KEY,
    systemPrompt: fileConfig.systemPrompt || null,
  };
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

// --- Anthropic API (streaming) ---

async function callAnthropic(messages, config) {
  const systemPrompt = buildSystemPrompt(config);

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
      system: systemPrompt,
      stream: true,
      messages,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API error ${resp.status}: ${body}`);
  }

  // Parse SSE stream
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
        if (event.type === 'content_block_delta' && event.delta?.text) {
          const text = event.delta.text;
          fullText += text;
          process.stderr.write(text);
        }
      } catch {}
    }
  }

  process.stderr.write('\n\n');
  return fullText;
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

Environment:
  ANTHROPIC_API_KEY   Your Anthropic API key (required)
  AI_SHELL_MODEL      Model to use (default: claude-sonnet-4-6)
  AI_SHELL_PROVIDER   API provider (default: anthropic)

Config file: ~/.config/ai-shell/config.json
History:    ~/.local/share/ai-shell/history.jsonl
`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const config = loadConfig();

  if (!config.apiKey) {
    process.stderr.write('Error: No API key found.\n');
    process.stderr.write('Set ANTHROPIC_API_KEY or add apiKey to ~/.config/ai-shell/config.json\n');
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
    fullText = await callAnthropic(messages, config);
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
