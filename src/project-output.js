import { FILES_INSTRUCTION, SITE_INSTRUCTION } from './config.js';

const PROJECT_REQUEST = /(?:созд[а-яёa-z]*|сдел[а-яёa-z]*|напиш[а-яёa-z]*|сгенер[а-яёa-z]*|разработ[а-яёa-z]*|постро[а-яёa-z]*|create|build|write|implement|generate)[\s\S]{0,500}?(?:сайт[а-яёa-z]*|страниц[а-яёa-z]*|приложени[а-яёa-z]*|проект[а-яёa-z]*|бот[а-яёa-z]*|скрипт[а-яёa-z]*|код[а-яёa-z]*|игр[а-яёa-z]*|файл[а-яёa-z]*|website|page|app|project|bot|script|code|game|file)/iu;
const CODE_OUTPUT = /%%%FILE\s+[^\n%]+?\s*%%%|```[\w.+#-]*\s*\n[\s\S]+?```/u;

export function wantsProjectOutput(prompt) {
  return PROJECT_REQUEST.test(String(prompt || ''));
}

export function hasProjectOutput(text) {
  return CODE_OUTPUT.test(String(text || ''));
}

export function projectPrompt(prompt) {
  if (!wantsProjectOutput(prompt)) return prompt;
  return `${prompt}\n\nТребование к результату: в этом ответе выдай сам рабочий код и файлы, не останавливайся на плане, рассуждении или обещании написать их позже. ${FILES_INSTRUCTION}\n\n${SITE_INSTRUCTION}`;
}

export function continuationPrompt() {
  return 'Ты описал план, но не выдал запрошенный код. Сейчас пришли рабочие файлы или блоки кода полностью. Не повторяй план и не обещай сделать это позже. Каждый файл допиши до конца.';
}

export function combineModelUsage(first, second) {
  const a = first?.tokens || {};
  const b = second?.tokens || {};
  const tokens = {};
  for (const key of ['input', 'output', 'cacheWrite', 'cacheRead', 'total', 'billable', 'promptTokens']) {
    tokens[key] = (Number(a[key]) || 0) + (Number(b[key]) || 0);
  }
  return {
    ...second,
    tokens,
    costUsd: (Number(first?.costUsd) || 0) + (Number(second?.costUsd) || 0),
    durationMs: (Number(first?.durationMs) || 0) + (Number(second?.durationMs) || 0),
  };
}
