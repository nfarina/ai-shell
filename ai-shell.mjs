#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync, execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';

const APP_NAME = 'ai-shell';
const REPO_OWNER = 'nfarina';
const REPO_NAME = 'ai-shell';
const DEFAULT_BRANCH = 'main';
const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${DEFAULT_BRANCH}/install.sh`;
const VERSION_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${DEFAULT_BRANCH}/VERSION`;
const VERSION = readTextFile(new URL('./VERSION', import.meta.url)).trim() || '0.0.0';

const HOME_DIR = homedir();
const CONFIG_DIR = join(HOME_DIR, '.config', APP_NAME);
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const DATA_DIR = join(HOME_DIR, '.local', 'share', APP_NAME);
const HISTORY_FILE = join(DATA_DIR, 'history.jsonl');
const UPDATE_CACHE_FILE = join(DATA_DIR, 'update-check.json');

const PROVIDERS = {
  anthropic: {
    defaultModel: 'claude-sonnet-4-6',
    envKey: 'ANTHROPIC_API_KEY',
    apiKeyUrl: 'https://console.anthropic.com/',
    call: callAnthropic,
  },
  openai: {
    defaultModel: 'gpt-5.4-mini',
    envKey: 'OPENAI_API_KEY',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    call: callOpenAI,
  },
  gemini: {
    defaultModel: 'gemini-3-flash-preview',
    envKey: 'GEMINI_API_KEY',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    call: callGemini,
  },
};

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function readTextFile(pathLike) {
  try {
    return readFileSync(pathLike, 'utf-8');
  } catch {
    return '';
  }
}

function loadJson(pathLike, fallback = {}, warnLabel = null) {
  if (!existsSync(pathLike)) return fallback;

  try {
    return JSON.parse(readFileSync(pathLike, 'utf-8'));
  } catch (err) {
    if (warnLabel) {
      process.stderr.write(`\x1b[33mWarning: failed to parse ${warnLabel}: ${err.message}\x1b[0m\n`);
    }
    return fallback;
  }
}

function writeJson(pathLike, value, { mode } = {}) {
  ensureDir(dirname(pathLike));
  writeFileSync(pathLike, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
}

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

function detectProviderFromEnv() {
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    if (process.env[spec.envKey]) {
      return name;
    }
  }
  return null;
}

function loadConfig() {
  const fileConfig = loadJson(CONFIG_PATH, {}, CONFIG_PATH);
  const provider = process.env.AI_SHELL_PROVIDER || fileConfig.provider || detectProviderFromEnv() || 'anthropic';
  const spec = PROVIDERS[provider];

  if (!spec) {
    process.stderr.write(`\x1b[31mError: unknown provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(', ')}\x1b[0m\n`);
    process.exit(1);
  }

  return {
    fileConfig,
    provider,
    spec,
    model: process.env.AI_SHELL_MODEL || fileConfig.model || spec.defaultModel,
    apiKey: process.env[spec.envKey] || fileConfig.apiKey || null,
    systemPrompt: process.env.AI_SHELL_SYSTEM_PROMPT || fileConfig.systemPrompt || null,
  };
}

function printSetupHint(provider) {
  const spec = PROVIDERS[provider];
  process.stderr.write(`\x1b[31mNo API key configured for provider "${provider}".\x1b[0m\n`);
  process.stderr.write(`Run \x1b[1mai --setup\x1b[0m to create ${CONFIG_PATH}.\n`);
  process.stderr.write(`Optional env override: ${spec.envKey} (${spec.apiKeyUrl})\n`);
}

async function runSetup(existingConfig = {}) {
  if (!isInteractive()) {
    process.stderr.write(`Error: setup requires an interactive terminal. Create ${CONFIG_PATH} manually.\n`);
    process.exit(1);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    process.stderr.write(`\n${APP_NAME} setup\n`);
    process.stderr.write(`This writes your config to ${CONFIG_PATH}.\n`);
    process.stderr.write('API keys are stored in plain text in that file.\n\n');

    const provider = await promptForProvider(rl, existingConfig.provider || detectProviderFromEnv() || 'anthropic');
    const spec = PROVIDERS[provider];
    const defaultModel = existingConfig.model || spec.defaultModel;
    const existingApiKey = existingConfig.provider === provider ? (existingConfig.apiKey || '') : '';
    const envApiKey = process.env[spec.envKey] || '';
    const currentApiKey = existingApiKey || envApiKey;

    process.stderr.write(`Get a ${provider} API key here: ${spec.apiKeyUrl}\n`);

    let apiKey = '';
    while (!apiKey) {
      const promptSuffix = currentApiKey ? ' [press enter to keep current value]' : '';
      const response = await rl.question(`API key${promptSuffix}: `);
      apiKey = response.trim() || currentApiKey;
      if (!apiKey) {
        process.stderr.write('An API key is required.\n');
      }
    }

    const modelResponse = await rl.question(`Model [${defaultModel}]: `);
    const model = modelResponse.trim() || defaultModel;

    const config = {
      provider,
      model,
      apiKey,
      systemPrompt: existingConfig.systemPrompt || null,
    };

    writeJson(CONFIG_PATH, config, { mode: 0o600 });
    process.stderr.write(`\nSaved ${CONFIG_PATH}\n\n`);
    return config;
  } finally {
    rl.close();
  }
}

async function promptForProvider(rl, defaultProvider) {
  const providerNames = Object.keys(PROVIDERS);
  const options = providerNames
    .map((name, index) => `${index + 1}. ${name}${name === defaultProvider ? ' (default)' : ''}`)
    .join('\n');

  while (true) {
    process.stderr.write(`Choose a provider:\n${options}\n`);
    const answer = (await rl.question(`Provider [${defaultProvider}]: `)).trim().toLowerCase();

    if (!answer) return defaultProvider;
    if (PROVIDERS[answer]) return answer;

    const numericChoice = Number.parseInt(answer, 10);
    if (Number.isInteger(numericChoice) && numericChoice >= 1 && numericChoice <= providerNames.length) {
      return providerNames[numericChoice - 1];
    }

    process.stderr.write(`Unknown provider "${answer}".\n`);
  }
}

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
  ensureDir(DATA_DIR);
  appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`);
}

function getLastThread() {
  const history = readHistory();
  if (history.length === 0) return [];

  const thread = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    thread.unshift(history[i]);
    if (history[i].newThread) break;
  }

  return thread.slice(-10);
}

function getSystemContext() {
  let os = 'unknown';
  try {
    os = execSync('uname -s', { encoding: 'utf-8' }).trim();
  } catch {}

  return {
    os,
    cwd: process.cwd(),
    shell: process.env.SHELL || 'zsh',
  };
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

  let userMsg = query;
  if (lastExitCode !== null && lastExitCode !== undefined && lastExitCode !== '0' && lastExitCode !== 0) {
    userMsg = `The previous command exited with code ${lastExitCode}.\n\n${query}`;
  }
  messages.push({ role: 'user', content: userMsg });

  return messages;
}

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
    buf = lines.pop();

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

  return streamSSE(resp, event => (
    event.type === 'content_block_delta' ? event.delta?.text : null
  ));
}

async function callOpenAI(messages, config) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
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

  return streamSSE(resp, event => event.choices?.[0]?.delta?.content);
}

async function callGemini(messages, config) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`;
  const contents = messages.map(message => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
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

  return streamSSE(resp, event => event.candidates?.[0]?.content?.parts?.[0]?.text);
}

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

  const stripped = text.replace(/```[\w]*\n?/g, '').trim();
  return { type: 'command', command: stripped, explanation: null };
}

function compareVersions(left, right) {
  const parse = version => version
    .replace(/^v/, '')
    .split('.')
    .map(part => Number.parseInt(part, 10) || 0);

  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

async function fetchLatestVersion() {
  const resp = await fetch(VERSION_URL, {
    headers: { 'User-Agent': APP_NAME },
    signal: AbortSignal.timeout(1500),
  });

  if (!resp.ok) {
    throw new Error(`Unable to fetch latest version (${resp.status})`);
  }

  return (await resp.text()).trim();
}

function loadUpdateCache() {
  return loadJson(UPDATE_CACHE_FILE, {});
}

function saveUpdateCache(cache) {
  writeJson(UPDATE_CACHE_FILE, cache);
}

async function checkForUpdates({ force = false } = {}) {
  const now = Date.now();
  const cache = loadUpdateCache();
  const stale = !cache.checkedAt || (now - cache.checkedAt) > 24 * 60 * 60 * 1000;

  if (!force && !stale && cache.latestVersion) {
    return {
      currentVersion: VERSION,
      latestVersion: cache.latestVersion,
      isUpdateAvailable: compareVersions(cache.latestVersion, VERSION) > 0,
    };
  }

  try {
    const latestVersion = await fetchLatestVersion();
    saveUpdateCache({ checkedAt: now, latestVersion });
    return {
      currentVersion: VERSION,
      latestVersion,
      isUpdateAvailable: compareVersions(latestVersion, VERSION) > 0,
    };
  } catch {
    return null;
  }
}

async function maybeNotifyUpdate() {
  if (!isInteractive()) return;

  const updateInfo = await checkForUpdates();
  if (!updateInfo || !updateInfo.isUpdateAvailable) return;

  process.stderr.write(`\x1b[33mUpdate available: ${updateInfo.currentVersion} -> ${updateInfo.latestVersion}. Run "ai --update".\x1b[0m\n`);
}

function runUpdate() {
  process.stderr.write(`Updating ${APP_NAME} via ${INSTALL_SCRIPT_URL}\n`);
  const result = spawnSync('bash', ['-lc', `curl -fsSL '${INSTALL_SCRIPT_URL}' | bash`], {
    stdio: 'inherit',
  });

  if (result.error) {
    process.stderr.write(`Error: ${result.error.message}\n`);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

function printHelp() {
  process.stderr.write(`Usage: ai-shell [options] <query>

Options:
  --setup          Create or rewrite ${CONFIG_PATH}
  --update         Download and install the latest version from GitHub
  --version        Print the installed version
  --followup       Continue the last conversation thread
  --exit-code=N    Exit code of the last command (auto-provided by shell wrapper)
  --help, -h       Show this help

Examples:
  ai "list files sorted by size"
  ai --setup
  ai --update
  ai-shell --followup "that didn't work, try a different approach"

Config file: ${CONFIG_PATH}
History:     ${HISTORY_FILE}
Version:     ${VERSION}
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    process.exit(1);
  }

  let followup = false;
  let setupOnly = false;
  let updateOnly = false;
  let showVersion = false;
  let lastExitCode = null;
  const queryParts = [];

  for (const arg of args) {
    if (arg === '--followup') {
      followup = true;
    } else if (arg === '--setup') {
      setupOnly = true;
    } else if (arg === '--update') {
      updateOnly = true;
    } else if (arg === '--version') {
      showVersion = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith('--exit-code=')) {
      lastExitCode = arg.split('=')[1];
    } else {
      queryParts.push(arg);
    }
  }

  if (showVersion) {
    process.stderr.write(`${APP_NAME} ${VERSION}\n`);
    process.exit(0);
  }

  if (updateOnly) {
    runUpdate();
  }

  let config = loadConfig();

  if (setupOnly) {
    await runSetup(config.fileConfig);
    process.exit(0);
  }

  const query = queryParts.join(' ');
  if (!query) {
    process.stderr.write('Error: No query provided.\n');
    process.exit(1);
  }

  if (!config.apiKey) {
    if (isInteractive()) {
      process.stderr.write('No config found. Starting first-run setup.\n');
      await runSetup(config.fileConfig);
      config = loadConfig();
    } else {
      printSetupHint(config.provider);
      process.exit(1);
    }
  }

  let messages;
  if (followup) {
    messages = buildMessages(query, getLastThread(), lastExitCode);
  } else {
    messages = [{ role: 'user', content: query }];
  }

  process.stderr.write('\x1b[2m');

  let fullText;
  try {
    fullText = await config.spec.call(messages, config);
  } catch (err) {
    process.stderr.write(`\x1b[0m\x1b[31mError: ${err.message}\x1b[0m\n`);
    process.exit(1);
  }

  process.stderr.write('\x1b[0m');

  const result = parseResponse(fullText);
  if (result.type === 'clarify') {
    // The streamed output already showed the clarify message; don't re-print it.
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

  process.stderr.write(`\x1b[32m→ ${result.command}\x1b[0m\n`);
  appendHistory({
    timestamp: Date.now(),
    newThread: !followup,
    query,
    command: result.command,
    explanation: result.explanation,
  });

  await maybeNotifyUpdate();

  process.stdout.write(result.command);
}

main();
