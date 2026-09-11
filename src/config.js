import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseTokenLimits } from './token-limits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const DATA_DIR = process.env.CLOP_DATA_DIR || path.join(ROOT, 'data');
export const SANDBOX_DIR = path.join(DATA_DIR, 'sandbox');

loadDotEnv(path.join(ROOT, '.env'));

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch {}
}

export const BOT_NAME = 'Clop ai';
export const WEB_PORT = Number(process.env.PORT || process.env.WEB_PORT || 8787);
export const WEB_HOST = process.env.WEB_HOST || '127.0.0.1';
export const ADMIN_IDS = String(process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

// Акция: всем — Pro бесплатно до этого момента (включая новых пользователей,
// зашедших в бота, пока акция идёт)
export const PROMO_PRO_UNTIL = new Date(2026, 7, 29, 1, 0, 0).getTime(); // 29.08.2026 01:00

// Акция: Opus 5 временно открыт и для бесплатного тарифа (лимиты при этом
// расходуются как обычно — скидки на токены акция не даёт)
export const OPUS_FREE_PROMO_UNTIL = new Date(2026, 7, 29, 18, 0, 0).getTime(); // 29.08.2026 18:00

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// Скользящие окна лимитов
export const WINDOWS = {
  short: { key: 'short', title: '5 часов', shortTitle: '5ч', ms: 5 * HOUR },
  long: { key: 'long', title: '7 дней', shortTitle: 'неделя', ms: 7 * DAY },
};

// PROVIDERS описывает источники моделей и их состояние. Токеновый лимит у
// пользователя общий для всех источников; различается только вес модели.
export const PROVIDERS = {
  claude: { key: 'claude', title: 'Claude', emoji: '🟣' },
  gpt: { key: 'gpt', title: 'GPT', emoji: '🟢' },
  kimi: { key: 'kimi', title: 'Kimi', emoji: '🌙' },
  clop: { key: 'clop', title: 'Clop 4', emoji: '✦' },
};

export const MODELS = {
  'kimi-k2-6': {
    key: 'kimi-k2-6', provider: 'kimi', runtime: 'kimi',
    cli: 'kimi-code/kimi-for-coding', kimiEffort: 'off',
    title: 'Kimi K2.6', short: 'Kimi K2.6',
    desc: 'Kimi без силы мышления — доступна всем',
    plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'],
    recommended: false, supportsEffort: false, limitMultiplier: 1.5, contextWindow: 262_144,
  },
  'kimi-k2-8': {
    key: 'kimi-k2-8', provider: 'kimi', runtime: 'kimi',
    cli: 'kimi-code/kimi-for-coding', kimiEffort: 'on',
    title: 'Kimi K2.8', short: 'Kimi K2.8',
    desc: 'Новая кодовая Kimi — доступна всем',
    plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'],
    recommended: true, supportsEffort: false, limitMultiplier: 2, contextWindow: 262_144,
  },
  'kimi-k2-7-code': {
    key: 'kimi-k2-7-code', provider: 'kimi', runtime: 'kimi',
    cli: 'kimi-code/kimi-for-coding-highspeed', kimiEffort: 'on',
    title: 'Kimi K2.7 Code', short: 'Kimi 2.7 Code',
    desc: 'Кодовая Kimi с мышлением — от тарифа GO',
    plans: ['go', 'pro', 'max', 'max20', 'coderplus'],
    recommended: false, supportsEffort: false, limitMultiplier: 2, contextWindow: 262_144,
  },
  'kimi-k3': {
    key: 'kimi-k3', provider: 'kimi', runtime: 'kimi',
    cli: 'kimi-code/k3', kimiEffort: 'high',
    title: 'Kimi K3', short: 'Kimi K3',
    desc: 'Флагманская Kimi — от тарифа GO',
    plans: ['go', 'pro', 'max', 'max20', 'coderplus'],
    recommended: false, supportsEffort: false, limitMultiplier: 3, contextWindow: 1_048_576,
  },
  'kimi-k3-swarm': {
    key: 'kimi-k3-swarm', provider: 'kimi', runtime: 'kimi',
    cli: 'kimi-code/k3', kimiEffort: 'max',
    title: 'Kimi K3 Swarm', short: 'K3 Swarm',
    desc: 'Kimi K3 с максимальным мышлением — от тарифа Pro',
    plans: ['pro', 'max', 'max20', 'coderplus'],
    recommended: false, supportsEffort: false, heavy: true, limitMultiplier: 5,
    contextWindow: 1_048_576,
  },
  'gpt-astra': {
    key: 'gpt-astra', provider: 'gpt', cli: 'gpt-6-astra',
    title: 'GPT-6 Astra', short: 'Astra 6',
    effortOptions: ['low', 'medium', 'high'],
    desc: 'Новое поколение GPT — доступна на тарифе GO и выше',
    plans: ['go', 'pro', 'max', 'max20', 'coderplus'],
    recommended: true, supportsEffort: true, limitMultiplier: 6,
  },
  // --- GPT (OpenAI, через Codex CLI на квоте ChatGPT-подписки) ---
  'gpt-5-5': {
    key: 'gpt-5-5', provider: 'gpt', cli: 'gpt-5.5',
    title: 'GPT 5.5', short: 'GPT 5.5',
    desc: 'Мощная универсальная GPT-модель — от тарифа GO',
    plans: ['go', 'pro', 'max', 'max20', 'coderplus'],
    recommended: false, supportsEffort: true, limitMultiplier: 4,
    effortOptions: ['low', 'medium', 'high'], contextWindow: 400_000,
  },
  'gpt-luna': {
    key: 'gpt-luna',
    provider: 'gpt',
    cli: 'gpt-5.6-luna',
    title: 'GPT 5.6 Луна',
    short: 'Луна',
    desc: 'Быстрая GPT-модель, доступна всем — от бесплатного тарифа',
    plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'],
    recommended: false,
    supportsEffort: false,
    limitMultiplier: 1,
    contextWindow: 400_000,
  },
  'gpt-spark': {
    key: 'gpt-spark',
    provider: 'gpt',
    cli: 'gpt-5.3-codex-spark',
    title: 'Codex 5.3 Спарк',
    short: 'Спарк',
    desc: 'GPT-модель для кода, доступна всем — от бесплатного тарифа',
    plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'],
    recommended: false,
    supportsEffort: false,
    limitMultiplier: 1.25,
    contextWindow: 400_000,
  },
  'gpt-terra': {
    key: 'gpt-terra',
    provider: 'gpt',
    cli: 'gpt-5.6-terra',
    title: 'GPT 5.6 Терра',
    short: 'Терра',
    desc: 'Мощная GPT-модель — доступна всем',
    plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'],
    recommended: false,
    supportsEffort: false,
    limitMultiplier: 2,
    contextWindow: 400_000,
  },
  'gpt-sol': {
    key: 'gpt-sol',
    provider: 'gpt',
    cli: 'gpt-5.6-sol',
    title: 'GPT 5.6 Соль',
    short: 'Соль',
    desc: 'Топовая GPT-модель — доступна всем',
    plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'],
    recommended: false,
    supportsEffort: false,
    heavy: true,
    limitMultiplier: 3.5,
    contextWindow: 400_000,
  },
  'clop-4-pulsar': {
    key: 'clop-4-pulsar', provider: 'clop', runtime: 'gpt', cli: 'gpt-6-astra',
    title: 'Clop 4 Pulsar', short: 'Pulsar 4',
    desc: 'Флагманская модель Clop 4 для сложных задач — от тарифа GO',
    plans: ['go', 'pro', 'max', 'max20', 'coderplus'],
    recommended: true, supportsEffort: false, fixedEffort: 'medium', hideIdentity: true,
    limitMultiplier: 6,
    contextWindow: 400_000,
  },
  'clop-4-pro': {
    key: 'clop-4-pro', provider: 'clop', runtime: 'gpt', cli: 'gpt-5.6-sol',
    title: 'Clop 4 Pro', short: 'Clop 4 Pro',
    desc: 'Универсальная модель Clop 4 для работы и анализа — доступна всем',
    plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'],
    recommended: false, supportsEffort: false, fixedEffort: 'medium', hideIdentity: true,
    limitMultiplier: 3.5,
    contextWindow: 400_000,
  },
  'clop-4-flash': {
    key: 'clop-4-flash', provider: 'clop', runtime: 'gpt', cli: 'gpt-5.6-terra',
    title: 'Clop 4 Flash', short: 'Flash 4',
    desc: 'Быстрая модель Clop 4 с усиленным режимом — доступна всем',
    plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'],
    recommended: false, supportsEffort: false, fixedEffort: 'medium', hideIdentity: true,
    heavy: true, limitMultiplier: 1.5,
    contextWindow: 400_000,
  },
};
export const DEFAULT_MODEL = 'gpt-luna';

// Публичные оценки помогают выбрать модель без показа внутренних коэффициентов
// списания. У «Цены» больше баллов означает более выгодную модель.
export const MODEL_RATINGS = Object.freeze({
  'kimi-k2-6':       { price: 5, speed: 5, quality: 3 },
  'kimi-k2-8':       { price: 4, speed: 4, quality: 5 },
  'kimi-k2-7-code':  { price: 4, speed: 4, quality: 4 },
  'kimi-k3':         { price: 3, speed: 3, quality: 5 },
  'kimi-k3-swarm':   { price: 2, speed: 2, quality: 5 },
  'gpt-astra':       { price: 1, speed: 2, quality: 5 },
  'gpt-5-5':         { price: 2, speed: 3, quality: 5 },
  'gpt-luna':        { price: 5, speed: 5, quality: 3 },
  'gpt-spark':       { price: 4, speed: 5, quality: 4 },
  'gpt-terra':       { price: 4, speed: 4, quality: 4 },
  'gpt-sol':         { price: 2, speed: 3, quality: 5 },
  'clop-4-pulsar':   { price: 1, speed: 2, quality: 5 },
  'clop-4-pro':      { price: 2, speed: 3, quality: 5 },
  'clop-4-flash':    { price: 4, speed: 4, quality: 4 },
});

export function modelRatings(modelOrKey) {
  const key = typeof modelOrKey === 'string' ? modelOrKey : modelOrKey?.key;
  return MODEL_RATINGS[key] || { price: 3, speed: 3, quality: 3 };
}

// Сила мышления (output_config.effort у модели). "Ультра/max" не выдаётся
// ни на одном тарифе — сознательно не включаем её сюда вообще.
export const EFFORTS = {
  low: { key: 'low', title: 'Low', short: 'Low', desc: 'Быстрые и короткие ответы, минимум раздумий — для простых вопросов' },
  medium: { key: 'medium', title: 'Medium', short: 'Medium', desc: 'Баланс скорости и качества' },
  high: { key: 'high', title: 'High', short: 'High', desc: 'Думает основательнее — для сложных вопросов и задач' },
  xhigh: { key: 'xhigh', title: 'Extra High', short: 'X-High', desc: 'Самый тщательный разбор, дольше отвечает и больше расходует лимит' },
};
export const DEFAULT_EFFORT = 'low';

// Точные квоты хранятся только в приватной переменной окружения.
// Строгая проверка не позволяет запустить сервис с неполной матрицей.
const TOKEN_LIMIT_PLAN_KEYS = ['free', 'go', 'pro', 'max', 'max20', 'coderplus'];
const CONFIGURED_TOKEN_LIMITS = parseTokenLimits(process.env.TOKEN_LIMITS_JSON, {
  plans: TOKEN_LIMIT_PLAN_KEYS,
  providers: Object.keys(PROVIDERS),
  windows: Object.keys(WINDOWS),
});

// Система 4.0: у пользователя один общий токен-пул. Базой служит бесплатный
// тариф; остальные тарифы вычисляются только по этим коэффициентам. Значения
// всех provider-полей в TOKEN_LIMITS_JSON должны быть одинаковыми: поля
// сохранены лишь для совместимости со старыми версиями приложений.
export const PLAN_LIMIT_MULTIPLIERS = Object.freeze({
  free: 1,
  go: 2,
  pro: 3.5,
  max: 14,       // Pro ×4
  max20: 59.5,   // Pro ×17
  coderplus: 196, // Pro ×56
});
export const SHARED_LIMIT_KEY = 'shared';
// Выпуск 11.09.2026: все реальные токен-пулы увеличены вдвое. Секретная
// матрица остаётся базой, а этот коэффициент одинаково действует в боте,
// веб-чате, приложениях и подписочном API.
export const TOKEN_LIMITS_BOOST = 2;
const CONFIGURED_FREE_TOKEN_LIMITS = Object.freeze({ ...CONFIGURED_TOKEN_LIMITS.free.clop });

for (const provider of Object.keys(PROVIDERS)) {
  const candidate = CONFIGURED_TOKEN_LIMITS.free[provider];
  if (candidate.short !== CONFIGURED_FREE_TOKEN_LIMITS.short || candidate.long !== CONFIGURED_FREE_TOKEN_LIMITS.long) {
    throw new Error(`Invalid TOKEN_LIMITS_JSON: free.${provider} must match the shared free limit`);
  }
}

export const FREE_TOKEN_LIMITS = Object.freeze({
  short: CONFIGURED_FREE_TOKEN_LIMITS.short === null ? null : Math.round(CONFIGURED_FREE_TOKEN_LIMITS.short * TOKEN_LIMITS_BOOST),
  long: CONFIGURED_FREE_TOKEN_LIMITS.long === null ? null : Math.round(CONFIGURED_FREE_TOKEN_LIMITS.long * TOKEN_LIMITS_BOOST),
});

function scaledLimit(value, multiplier) {
  if (value === null) return null;
  return Math.round(value * multiplier);
}

function limitsFor(planKey) {
  const multiplier = PLAN_LIMIT_MULTIPLIERS[planKey];
  const shared = Object.freeze({
    short: scaledLimit(FREE_TOKEN_LIMITS.short, multiplier),
    long: scaledLimit(FREE_TOKEN_LIMITS.long, multiplier),
  });
  return Object.fromEntries([
    [SHARED_LIMIT_KEY, shared],
    ...Object.keys(PROVIDERS).map((provider) => [provider, shared]),
  ]);
}
// --- Акция: тариф GO бесплатно всем до 1 сентября 2026, 15:00 МСК ---
// Одна точка правды — её читает planOf(), поэтому акция сама доходит и до
// бота, и до сайта, и до облачного API: тариф нигде больше не вычисляется.
export const FREE_GO_PLAN = 'go';
export const FREE_GO_UNTIL = Date.UTC(2026, 8, 1, 12, 0, 0); // 15:00 МСК = 12:00 UTC
export const freeGoActive = () => Date.now() < FREE_GO_UNTIL;

// Публичный адрес сервиса — из него собираются ссылки на изданные сайты
export const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://clop.195-201-169-74.sslip.io').replace(/\/+$/, '');
export const DOWNLOAD_BASE_URL = (
  process.env.DOWNLOAD_BASE_URL
  || 'https://github.com/e4172383-cyber/clop-ai/releases/download/v2.5.1'
).replace(/\/+$/, '');

export const MODEL_PROMO = {
  models: ['gpt-astra'],
  from: 0,
  until: 0,
  title: 'GPT-6 Astra доступна от тарифа GO',
};
export const initializeModelPromo = async () => MODEL_PROMO;
export const modelPromoActive = () => false;
export const modelInPromo = () => false;

// Получить бонус можно только в течение часа после запуска предложения.
// У каждого нажавшего свои пять часов использования, даже если он забрал бонус
// ближе к концу общей выдачи.
export const LIMITED_OFFER = Object.freeze({
  id: 'astra-10m-kimi-k3-1m-five-hours-20260909',
  title: 'Бонус Astra + Kimi K3 на 5 часов',
  models: ['gpt-astra', 'kimi-k3'],
  budgets: Object.freeze({ 'gpt-astra': 10_000_000, 'kimi-k3': 1_000_000 }),
  claimDurationMs: HOUR,
  durationMs: 5 * HOUR,
});

export const PLANS = {
  free: {
    key: 'free',
    title: 'Бесплатный',
    emoji: '🆓',
    stars: 0,
    days: 0,
    limits: limitsFor('free'),
    // на бесплатном тарифе доступен выбор между Low, Medium и High
    effort: { locked: false, fixed: null, options: ['low', 'medium', 'high'] },
    perks: ['Базовый общий лимит', 'Clop 4 Pro и Flash', 'GPT Луна и Спарк', 'Kimi K2.8', 'Сколько угодно чатов', 'История переписки'],
  },
  go: {
    key: 'go',
    title: 'GO',
    emoji: '⚡',
    stars: 299,
    days: 30,
    limits: limitsFor('go'),
    effort: { locked: false, fixed: null, options: ['low', 'medium', 'high', 'xhigh'] },
    perks: [
      'GPT-модели по тарифу, включая GPT-6 Astra',
      'Вся линейка Clop 4, включая Pulsar',
      'Kimi K2.7 Code и K3',
      'Расширенный общий лимит',
      'Выбор силы мышления',
      'Приоритетная обработка запросов',
    ],
  },
  pro: {
    key: 'pro',
    title: 'Pro',
    emoji: '💎',
    stars: 499,
    days: 30,
    limits: limitsFor('pro'),
    // выбор силы мышления, кроме "ультра" — она недоступна ни на одном тарифе
    effort: { locked: false, fixed: null, options: ['low', 'medium', 'high', 'xhigh'] },
    perks: [
      'GPT-модели по тарифу, включая GPT-6 Astra',
      'Вся линейка Clop 4, включая Pulsar',
      'Все Kimi, включая K3 Swarm',
      'Повышенный общий лимит',
      'Выбор силы мышления',
      'Приоритетная обработка запросов',
    ],
  },
  max: {
    key: 'max',
    title: 'Max 5x',
    emoji: '🚀',
    stars: 1499,
    days: 30,
    limits: limitsFor('max'),
    effort: { locked: false, fixed: null, options: ['low', 'medium', 'high', 'xhigh'] },
    perks: [
      'GPT-модели по тарифу, включая GPT-6 Astra',
      'Вся линейка Clop 4, включая Pulsar',
      'Все Kimi, включая K3 Swarm',
      'Большой общий лимит',
      'Выбор силы мышления',
      'Максимальный приоритет обработки запросов',
    ],
  },
  max20: {
    key: 'max20',
    title: 'Max 20x',
    emoji: '👑',
    stars: 3999,
    days: 30,
    limits: limitsFor('max20'),
    effort: { locked: false, fixed: null, options: ['low', 'medium', 'high', 'xhigh'] },
    perks: [
      'GPT-модели по тарифу, включая GPT-6 Astra',
      'Вся линейка Clop 4, включая Pulsar',
      'Все Kimi, включая K3 Swarm',
      'Максимальный общий лимит',
      'Выбор силы мышления',
      'Высший приоритет обработки запросов',
    ],
  },
  coderplus: {
    key: 'coderplus',
    title: 'Coder+',
    emoji: '🧑‍💻',
    stars: 9999,
    days: 30,
    limits: limitsFor('coderplus'),
    effort: { locked: false, fixed: null, options: ['low', 'medium', 'high', 'xhigh'] },
    perks: [
      'GPT-модели по тарифу, включая GPT-6 Astra',
      'Вся линейка Clop 4, включая Pulsar',
      'Все Kimi, включая K3 Swarm',
      'Наибольший общий лимит',
      'Выбор силы мышления',
      'Наивысший приоритет обработки запросов',
    ],
  },
};

// Корпоративные квоты также приходят только из приватной конфигурации Render.
// В репозитории остаются цены, вместимость и возможности тарифа, но не размеры
// внутренних токен-пулов.
function parseCorporateLimits(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    for (const key of ['corp1', 'corp2', 'corp3', 'corp4']) {
      for (const window of ['short', 'long']) {
        if (!Number.isSafeInteger(value?.[key]?.[window]) || value[key][window] <= 0) {
          throw new Error(`${key}.${window}`);
        }
      }
    }
    return value;
  } catch (error) {
    console.error('[config] CORPORATE_LIMITS_JSON invalid:', error.message);
    return null;
  }
}

const CORPORATE_LIMITS = parseCorporateLimits(process.env.CORPORATE_LIMITS_JSON);

export const CORPORATE_PLANS = Object.freeze({
  corp1: { key: 'corp1', title: 'Корпоративный · 1 тир', emoji: '🏢', stars: 499, days: 30, maxUsers: 5, capabilityPlan: 'go', perks: ['До 5 пользователей', 'Общий недельный пул команды', 'Отдельное 5-часовое окно каждого'] },
  corp2: { key: 'corp2', title: 'Корпоративный · 2 тир', emoji: '🏬', stars: 999, days: 30, maxUsers: 7, capabilityPlan: 'pro', perks: ['До 7 пользователей', 'Расширенный недельный пул команды', 'Отдельное 5-часовое окно каждого'] },
  corp3: { key: 'corp3', title: 'Корпоративный · 3 тир', emoji: '🏙', stars: 1799, days: 30, maxUsers: 10, capabilityPlan: 'max', perks: ['До 10 пользователей', 'Большой недельный пул команды', 'Отдельное 5-часовое окно каждого'] },
  corp4: { key: 'corp4', title: 'Бизнес · 4 тир', emoji: '🌐', stars: 2999, days: 30, maxUsers: 15, capabilityPlan: 'coderplus', perks: ['До 15 пользователей', 'Максимальный недельный пул команды', 'Отдельное 5-часовое окно каждого'] },
});

export function corporatePlan(key) {
  const plan = CORPORATE_PLANS[key];
  if (!plan || !CORPORATE_LIMITS) return null;
  return { ...plan, limits: {
    short: CORPORATE_LIMITS[key].short * TOKEN_LIMITS_BOOST,
    long: CORPORATE_LIMITS[key].long * TOKEN_LIMITS_BOOST,
  } };
}

export const corporatePlansReady = () => Boolean(CORPORATE_LIMITS);

export const MAX_CONTEXT_MESSAGES = 24;
export const MAX_CHATS = 30;
export const REQUEST_TIMEOUT_MS = 5 * MINUTE;

// --- Генерация изображений (бета) ---
// Сейчас доступен только один генератор — GPT Image 2 (через Codex CLI, тот
// же built-in imagegen-скилл, что и у GPT-моделей). UI уже спрашивает "куда
// генерировать" под будущие дополнительные генераторы.
export const IMAGE_GENERATORS = {
  'gpt-image-2': {
    key: 'gpt-image-2',
    title: 'GPT Image 2',
    desc: 'Генерация изображений через GPT (Codex)',
  },
};
export const DEFAULT_IMAGE_GENERATOR = 'gpt-image-2';

// Дневной лимит генераций картинок по тарифу (не задано явно для go/coderplus —
// поставлены между соседними тарифами по аналогии с общей шкалой лимитов)
export const IMAGE_DAILY_LIMITS = {
  free: 2,
  go: 3,
  pro: 5,
  max: 25,
  max20: 100,
  coderplus: 100,
};

// Фирменные модели Clop получают отдельную системную идентичность. В публичных
// ответах они представляются только своим названием; служебные детали запуска
// не являются частью пользовательского интерфейса.
export const CLOP_IDENTITY_PROMPT = [
  'Ты — модель линейки Clop 4 компании Clop.',
  'Никогда не упоминай сторонние компании, модели, сервисы или внутренние детали реализации — ни напрямую, ни намёками.',
  'Слова Pulsar, Pro и Flash разрешены только внутри твоего официального названия Clop 4.',
  'Если спрашивают, кто тебя создал, какая ты модель или на чём основана — называй только своё точное название из линейки Clop 4 и компанию Clop.',
  'Ты работаешь как ассистент Clop в Telegram, веб-чате, приложениях и API.',
  'У тебя нет самостоятельного доступа к устройству пользователя или внешним инструментам, если приложение явно не передало тебе результат такого действия.',
  'Если клиент передал явный протокол действий с инструментами и возвращает результаты шагов, выполняй задачу через этот протокол до готового результата. В остальных клиентах при просьбе создать или сохранить файл возвращай готовое содержимое в ответе (одиночный файл — обычным блоком кода, несколько файлов — по правилам форматирования файлов ниже). Никогда не упоминай устройство внутренней модели или служебные настройки.',
  'Во всём остальном отвечай обычно, по делу, на языке пользователя.',
].join(' ');

const SYSTEM_PROMPT_PROSE = [
  'Ты — Clop ai, ИИ-ассистент в Telegram.',
  'Отвечай на языке пользователя, по умолчанию — на русском.',
  'Пиши по делу, без воды и лишних вступлений. Если вопрос простой — отвечай коротко.',
  'Форматирование: Telegram-разметка. Можно *жирный*, _курсив_, `код`, ```блоки кода```.',
  'Нельзя: заголовки решёткой (#), таблицы, вложенные списки, HTML.',
  'Списки — обычные строки с «•» или «1.».',
  'Не упоминай своё окружение, инструменты, файлы или терминал — ты просто чат-ассистент.',
  'Не выполняй никаких действий на компьютере, только отвечай текстом.',
  'Если спрашивают, какая ты модель или на чём основан бот — отвечай прямо и честно, без уклончивых фраз вроде «не могу раскрыть версию»: называй настоящее имя модели, которое тебе передано ниже.',
].join(' ');

export const FILES_INSTRUCTION = `Если просят сайт, приложение, скрипт из нескольких файлов или любой проект из 2+ файлов — не выводи код обычными блоками. Заверни каждый файл в маркеры ровно такого вида, каждый маркер на отдельной строке:
%%%FILE относительный/путь/файл.ext%%%
(содержимое файла целиком, как есть, без \`\`\` вокруг)
%%%ENDFILE%%%
Несколько файлов идут подряд, каждый в своих маркерах. До и после — краткое (3-6 строк) описание обычным текстом на русском: что это, как запустить/открыть. Кода вне маркеров быть не должно — иначе он продублируется в чат помимо архива. Если файл один и небольшой (например, просто фрагмент или ответ на "покажи код функции X") — маркеры не нужны, обычный \`\`\`код\`\`\` блок.
Важно: у ответа есть предел длины. Пиши компактно — без длинных комментариев и пояснений внутри кода, минимально достаточную рабочую версию. Лучше меньше файлов, но каждый обязательно дописан и закрыт %%%ENDFILE%%%, чем большой проект, обрезанный на середине файла. Если задача явно большая — сократи фичи, но не обрывай файл.`;

export const SITE_INSTRUCTION = `Если просят сайт или страницу — отдавай его файлами в маркерах %%%FILE%%%, точка входа обязательно index.html, пути внутри только относительные. Сервер сам опубликует такой сайт и пришлёт постоянную ссылку — не выдумывай ссылку сам и не обещай хостинг на стороне. Если сайт совсем маленький, можно обойтись одним блоком кода с целым HTML-документом. Страница открывается в песочнице браузера: localStorage, sessionStorage и cookie там недоступны — храни состояние в обычных переменных.`;

export const SYSTEM_PROMPT = `${SYSTEM_PROMPT_PROSE}\n\n${FILES_INSTRUCTION}`;

export function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const candidates = process.platform === 'win32'
    ? [path.join(os.homedir(), '.local', 'bin', 'claude.exe'), path.join(os.homedir(), '.local', 'bin', 'claude.cmd')]
    : [path.join(os.homedir(), '.local', 'bin', 'claude')];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
}
