'use strict';

const path = require('node:path');

const PROVIDERS = Object.freeze({
  antigravity: {
    key: 'antigravity', title: 'Antigravity', command: 'agy', mark: 'A',
    quotaKind: 'antigravity',
    description: 'Ваш аккаунт Antigravity и доступные в нём модели',
    installUrl: 'https://antigravity.google/docs/cli/install/', loginArgs: [],
    models: [
      { id: 'auto', title: 'Antigravity Auto', cliModel: '', description: 'Автоматический выбор модели Antigravity' },
      { id: 'gemini-3.8', title: 'Gemini 3.8 Flash', cliModel: 'gemini-3.8-flash-medium', description: 'Новая быстрая Gemini 3.8 · Medium' },
      { id: 'gemini-3.7', title: 'Gemini 3.7 Flash', cliModel: 'gemini-3.7-flash-medium', description: 'Быстрая Gemini 3.7 · Medium' },
      { id: 'gemini-3.6', title: 'Gemini 3.6 Flash', cliModel: 'gemini-3.6-flash-medium', description: 'Быстрая Gemini 3.6 · Medium' },
      { id: 'gemini-3.1-pro', title: 'Gemini 3.1 Pro', cliModel: 'gemini-3.1-pro-high', description: 'Самая сильная Gemini Pro · High' },
    ],
  },
  gpt: {
    key: 'gpt', title: 'GPT / Codex', command: 'codex', mark: 'G',
    quotaKind: 'codex',
    description: 'Ваш ChatGPT или API-аккаунт в Codex CLI',
    installUrl: 'https://developers.openai.com/codex/cli/', loginArgs: ['login'],
    models: [
      { id: 'auto', title: 'GPT Auto', cliModel: '', description: 'Модель, выбранная в Codex CLI' },
      { id: 'gpt-6-astra', title: 'GPT-6 Astra', cliModel: 'gpt-6-astra', description: 'Максимальная модель GPT' },
      { id: 'gpt-5.6-sol', title: 'GPT 5.6 Sol', cliModel: 'gpt-5.6-sol', description: 'Сильная универсальная GPT-модель' },
      { id: 'gpt-5.6-terra', title: 'GPT 5.6 Terra', cliModel: 'gpt-5.6-terra', description: 'Сбалансированная GPT-модель' },
      { id: 'gpt-5.6-luna', title: 'GPT 5.6 Luna', cliModel: 'gpt-5.6-luna', description: 'Быстрая GPT-модель' },
    ],
  },
  claude: {
    key: 'claude', title: 'Claude', command: 'claude', mark: 'C',
    description: 'Ваш аккаунт Claude Code',
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup', loginArgs: [],
    models: [
      { id: 'auto', title: 'Claude Auto', cliModel: '', description: 'Модель, выбранная в Claude Code' },
      { id: 'opus', title: 'Claude Opus', cliModel: 'opus', description: 'Максимальное качество Claude' },
      { id: 'sonnet', title: 'Claude Sonnet', cliModel: 'sonnet', description: 'Баланс качества и скорости' },
      { id: 'haiku', title: 'Claude Haiku', cliModel: 'haiku', description: 'Быстрые ответы Claude' },
    ],
  },
  kimi: {
    key: 'kimi', title: 'Kimi', command: 'kimi', mark: 'K',
    description: 'Ваш аккаунт Kimi Code',
    installUrl: 'https://github.com/MoonshotAI/kimi-code', loginArgs: ['login'],
    models: [
      { id: 'auto', title: 'Kimi Auto', cliModel: '', description: 'Модель, выбранная в Kimi CLI' },
      { id: 'k2.8', title: 'Kimi K2.8', cliModel: 'kimi-code/kimi-for-coding', description: 'Новая кодовая модель Kimi' },
      { id: 'k2.7-code', title: 'Kimi K2.7 Code', cliModel: 'kimi-code/kimi-for-coding-highspeed', description: 'Скоростная кодовая Kimi' },
      { id: 'k3', title: 'Kimi K3', cliModel: 'kimi-code/k3', description: 'Флагманская модель Kimi' },
    ],
  },
  qwen: {
    key: 'qwen', title: 'Qwen', command: 'qwen', mark: 'Q',
    description: 'Ваш аккаунт Qwen Code',
    installUrl: 'https://github.com/QwenLM/qwen-code', loginArgs: [],
    models: [
      { id: 'auto', title: 'Qwen Auto', cliModel: '', description: 'Модель, выбранная в Qwen Code' },
      { id: 'qwen3-coder-plus', title: 'Qwen3 Coder Plus', cliModel: 'qwen3-coder-plus', description: 'Мощная кодовая модель Qwen' },
      { id: 'qwen3-coder-flash', title: 'Qwen3 Coder Flash', cliModel: 'qwen3-coder-flash', description: 'Быстрая кодовая модель Qwen' },
    ],
  },
});

function providerList() {
  return Object.values(PROVIDERS);
}

function providerByKey(key) {
  return PROVIDERS[String(key || '').toLowerCase()] || null;
}

function ownModelKey(providerKey, modelId) {
  return `own-${providerKey}-${modelId}`;
}

function ownModels(provider, available = true) {
  return provider.models.map((model) => ({
    key: ownModelKey(provider.key, model.id),
    source: 'own',
    provider: 'own',
    providerKey: provider.key,
    providerTitle: provider.title,
    title: model.title,
    description: `${model.description} · ваш лимит`,
    available,
    cliModel: model.cliModel,
  }));
}

function modelByKey(key) {
  for (const provider of providerList()) {
    const model = provider.models.find((item) => ownModelKey(provider.key, item.id) === key);
    if (model) return { ...model, key, provider };
  }
  return null;
}

function versionArgs(providerKey) {
  return providerByKey(providerKey) ? ['--version'] : null;
}

function commandForModel(selection, effort = 'low') {
  if (!selection?.provider) throw new Error('Неизвестная локальная модель.');
  const model = selection.cliModel;
  const normalizedEffort = ['low', 'medium', 'high', 'xhigh'].includes(effort) ? effort : 'low';
  switch (selection.provider.key) {
    case 'antigravity':
      return ['--input-format', 'stream-json', '--output-format', 'stream-json', '--sandbox', ...(model ? ['--model', model] : []), '--effort', normalizedEffort === 'xhigh' ? 'high' : normalizedEffort];
    case 'gpt':
      return ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', ...(model ? ['-m', model] : []), '-c', `model_reasoning_effort="${normalizedEffort}"`, '-'];
    case 'claude':
      return ['-p', '--output-format', 'json', '--permission-mode', 'plan', ...(model ? ['--model', model] : [])];
    case 'kimi':
      return ['-p', '-', '--output-format', 'stream-json', ...(model ? ['-m', model] : [])];
    case 'qwen':
      return ['--prompt', '-', '--output-format', 'json', ...(model ? ['--model', model] : [])];
    default:
      throw new Error('Этот локальный провайдер пока не поддерживается.');
  }
}

function inputForModel(selection, prompt) {
  if (selection?.provider?.key === 'antigravity') {
    return `${JSON.stringify({ event: 'user', message: { content: String(prompt || '') } })}\n`;
  }
  return String(prompt || '');
}

function compactVersion(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
}

function extractText(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  for (const key of ['result', 'response', 'output_text', 'text', 'content']) {
    const found = extractText(value[key]);
    if (found) return found;
  }
  if (value.item) {
    const found = extractText(value.item);
    if (found) return found;
  }
  if (value.message && (value.role === 'assistant' || value.message.role === 'assistant' || !value.role)) {
    const found = extractText(value.message);
    if (found) return found;
  }
  if (Array.isArray(value.content)) {
    return value.content.map(extractText).filter(Boolean).join('\n').trim();
  }
  return '';
}

function parseCliOutput(stdout, stderr = '') {
  const raw = String(stdout || '').trim();
  if (!raw) throw new Error(compactVersion(stderr) || 'CLI не вернул ответ. Проверьте вход в аккаунт.');
  try {
    const text = extractText(JSON.parse(raw));
    if (text) return text;
  } catch { /* some CLIs use JSONL or plain text */ }
  let last = '';
  for (const line of raw.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line);
      const text = extractText(parsed);
      if (text) last = text;
    } catch { /* retain plain fallback */ }
  }
  return last || raw;
}

function windowsCommand(executable, args) {
  const extension = path.extname(executable).toLowerCase();
  if (!['.cmd', '.bat'].includes(extension)) return { executable, args };
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  return {
    executable: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', [quote(executable), ...args.map(quote)].join(' ')],
  };
}

module.exports = {
  compactVersion,
  commandForModel,
  inputForModel,
  modelByKey,
  ownModels,
  parseCliOutput,
  providerByKey,
  providerList,
  versionArgs,
  windowsCommand,
};
