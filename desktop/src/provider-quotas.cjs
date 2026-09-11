'use strict';

const FIVE_HOURS_MINUTES = 5 * 60;
const WEEK_MINUTES = 7 * 24 * 60;

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number * 10) / 10));
}

function windowKey(minutes) {
  if (Number(minutes) === FIVE_HOURS_MINUTES) return 'five-hour';
  if (Number(minutes) === WEEK_MINUTES) return 'weekly';
  return `minutes-${Number(minutes) || 0}`;
}

function windowTitle(minutes) {
  if (Number(minutes) === FIVE_HOURS_MINUTES) return '5 часов';
  if (Number(minutes) === WEEK_MINUTES) return 'Неделя';
  if (Number(minutes) >= 60 && Number(minutes) % 60 === 0) return `${Number(minutes) / 60} ч`;
  return `${Number(minutes)} мин`;
}

function normalizeWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const usedPercent = clampPercent(raw.usedPercent);
  const minutes = Number(raw.windowDurationMins);
  if (usedPercent === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  const resetsAt = Number(raw.resetsAt);
  return {
    key: windowKey(minutes),
    title: windowTitle(minutes),
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowDurationMins: minutes,
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt * 1000 : null,
    resetText: '',
  };
}

function parseCodexQuotaResponse(message, now = Date.now()) {
  const result = message?.result || message || {};
  const source = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object'
    ? Object.values(result.rateLimitsByLimitId)
    : (result.rateLimits ? [result.rateLimits] : []);
  const groups = [];
  for (const bucket of source) {
    if (!bucket || typeof bucket !== 'object') continue;
    const windows = [normalizeWindow(bucket.primary), normalizeWindow(bucket.secondary)].filter(Boolean);
    if (!windows.length) continue;
    windows.sort((a, b) => a.windowDurationMins - b.windowDurationMins);
    groups.push({
      key: String(bucket.limitId || bucket.limitName || `quota-${groups.length + 1}`),
      title: String(bucket.limitName || (bucket.limitId === 'codex' ? 'Основные модели' : bucket.limitId) || 'Лимит моделей'),
      plan: bucket.planType ? String(bucket.planType) : '',
      windows,
    });
  }
  groups.sort((a, b) => {
    const aScore = a.windows.some((item) => item.key === 'five-hour') ? 0 : 1;
    const bScore = b.windows.some((item) => item.key === 'five-hour') ? 0 : 1;
    return aScore - bScore || a.title.localeCompare(b.title, 'ru');
  });
  if (!groups.length) throw new Error('Codex не вернул доступные окна квоты.');
  return { status: 'ok', source: 'Codex App Server', updatedAt: now, groups };
}

function stripTerminalFormatting(value) {
  return String(value || '')
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[│┃║╎╏┆┇┊┋]/g, ' ')
    .replace(/\r/g, '');
}

function quotaGroupTitle(line) {
  if (/gemini\s+models?/i.test(line)) return 'Gemini';
  if (/(claude\s*(?:and|&|и|\/)+\s*gpt|gpt\s*(?:and|&|и|\/)+\s*claude)/i.test(line)) return 'Claude и GPT';
  return '';
}

function quotaWindowKind(line) {
  if (/(five\s*hour|5\s*(?:hour|hours|h|час))/i.test(line)) return { key: 'five-hour', title: '5 часов' };
  if (/(weekly|week|7\s*(?:day|days|d|дн)|недел)/i.test(line)) return { key: 'weekly', title: 'Неделя' };
  return null;
}

function percentFromLine(line) {
  const match = String(line).match(/(\d+(?:[.,]\d+)?)\s*%/);
  return match ? clampPercent(Number(match[1].replace(',', '.'))) : null;
}

function resetFromLine(line) {
  const iso = String(line).match(/\b(20\d\d-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z)\b/i);
  if (iso) {
    const value = Date.parse(iso[1]);
    if (Number.isFinite(value)) return { resetsAt: value, resetText: '' };
  }
  const refresh = String(line).match(/(?:refresh(?:es)?|reset(?:s)?|обнов\w*|сброс\w*)\s*(?:in|через|:)?\s*([^|]+)$/i);
  return { resetsAt: null, resetText: refresh ? refresh[1].trim().slice(0, 80) : '' };
}

function parseAntigravityQuotaReport(output, now = Date.now()) {
  const lines = stripTerminalFormatting(output).split('\n').map((line) => line.trim()).filter(Boolean);
  const groups = new Map();
  let currentGroup = '';
  let pending = null;
  let lastWindow = null;

  const upsert = (groupTitle, kind, remainingPercent, reset) => {
    if (!groupTitle || !kind || remainingPercent === null) return;
    if (!groups.has(groupTitle)) groups.set(groupTitle, { key: groupTitle === 'Gemini' ? 'gemini' : 'claude-gpt', title: groupTitle, windows: [] });
    const group = groups.get(groupTitle);
    const window = {
      key: kind.key,
      title: kind.title,
      usedPercent: clampPercent(100 - remainingPercent),
      remainingPercent,
      windowDurationMins: kind.key === 'five-hour' ? FIVE_HOURS_MINUTES : WEEK_MINUTES,
      resetsAt: reset.resetsAt,
      resetText: reset.resetText,
    };
    const index = group.windows.findIndex((item) => item.key === kind.key);
    if (index >= 0) group.windows[index] = window;
    else group.windows.push(window);
    lastWindow = window;
  };

  for (const line of lines) {
    const inlineGroup = quotaGroupTitle(line);
    if (inlineGroup) currentGroup = inlineGroup;
    const kind = quotaWindowKind(line);
    const percent = percentFromLine(line);
    const reset = resetFromLine(line);
    if (kind && percent !== null) {
      upsert(inlineGroup || currentGroup, kind, percent, reset);
      pending = null;
      continue;
    }
    if (kind) {
      pending = { group: inlineGroup || currentGroup, kind, reset };
      continue;
    }
    if (pending && percent !== null) {
      const nextReset = reset.resetsAt || reset.resetText ? reset : pending.reset;
      upsert(pending.group, pending.kind, percent, nextReset);
      pending = null;
      continue;
    }
    if (pending && (reset.resetsAt || reset.resetText)) pending.reset = reset;
    else if (lastWindow && (reset.resetsAt || reset.resetText)) {
      lastWindow.resetsAt = reset.resetsAt;
      lastWindow.resetText = reset.resetText;
    }
  }

  const normalizedGroups = [...groups.values()].filter((group) => group.windows.length);
  for (const group of normalizedGroups) group.windows.sort((a, b) => a.windowDurationMins - b.windowDurationMins);
  if (!normalizedGroups.length) throw new Error('Antigravity не вернул квоту в поддерживаемом формате.');
  return { status: 'ok', source: 'Antigravity /usage', updatedAt: now, groups: normalizedGroups };
}

function publicQuotaError(message, now = Date.now()) {
  return { status: 'error', source: '', updatedAt: now, message: String(message || 'Не удалось получить квоту.').slice(0, 240), groups: [] };
}

module.exports = {
  parseAntigravityQuotaReport,
  parseCodexQuotaResponse,
  publicQuotaError,
};
