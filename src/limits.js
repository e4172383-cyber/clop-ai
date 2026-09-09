import { PLANS, FREE_GO_PLAN, freeGoActive, WINDOWS, EFFORTS, DEFAULT_EFFORT, MODELS, PROVIDERS, IMAGE_DAILY_LIMITS, DAY, corporatePlan } from './config.js';
import { eventBillable } from './token-accounting.js';
import * as store from './store.js';

// Модели, чей расход не считается против лимита тарифа (Haiku — навсегда)
const UNLIMITED_MODELS = new Set(Object.keys(MODELS).filter((k) => MODELS[k].unlimited));

// Все платные тарифы, кроме free — чтобы не перечислять их поштучно всякий раз
const PAID_PLANS = new Set(Object.keys(PLANS).filter((k) => k !== 'free'));
const LEGACY_MODEL_PROVIDERS = Object.freeze({
  'clop-3-1-pulsar': 'clop',
  'clop-3-1-opus': 'clop',
  'clop-3-1-haiku': 'clop',
});
const providerOfEvent = (event) => MODELS[event?.model]?.provider || LEGACY_MODEL_PROVIDERS[event?.model] || null;

export function planOf(u) {
  const team = store.activeTeamFor(u);
  if (team) {
    const corporate = corporatePlan(team.tier);
    const base = PLANS[corporate.capabilityPlan];
    return { ...base, title: corporate.title, emoji: corporate.emoji, corporateKey: corporate.key, teamId: team.id };
  }
  if (PAID_PLANS.has(u.plan) && (!u.proUntil || u.proUntil > Date.now())) return PLANS[u.plan];
  // Пока идёт акция, бесплатные аккаунты работают на GO целиком: те же
  // модели, лимиты и выбор силы мышления. Купленные тарифы не понижаем.
  if (freeGoActive()) return PLANS[FREE_GO_PLAN];
  return PLANS.free;
}

export function corporateStateOf(u, now = Date.now()) {
  const team = store.activeTeamFor(u, now);
  if (!team) return null;
  const plan = corporatePlan(team.tier);
  return plan ? { team, plan } : null;
}

// Доступные уровни силы мышления с учётом и тарифа, и модели: некоторые
// модели (например Fable 5) сами ограничены потолком ниже "ультра" —
// у Fable 5 максимум High, даже если тариф разрешает Extra High
export function allowedEffortOptions(u, model) {
  const plan = planOf(u);
  const cfg = plan.effort;
  let opts = cfg.locked ? [cfg.fixed].filter(Boolean) : cfg.options;
  if (model?.effortOptions) opts = opts.filter((k) => model.effortOptions.includes(k));
  return opts.length ? opts : [DEFAULT_EFFORT];
}

// Реальная сила мышления с учётом тарифа и (опционально) модели
export function effortOf(u, model) {
  const opts = allowedEffortOptions(u, model);
  const chosen = u.effort && opts.includes(u.effort) ? u.effort : opts[opts.length - 1];
  return EFFORTS[chosen] || EFFORTS[DEFAULT_EFFORT];
}

// billable — только вход+выход самого сообщения. Контекст (кэш системного
// промпта и истории диалога) в лимит 5ч/неделя не идёт — он теперь считается
// отдельно, против окна контекста модели (см. contextOf в bot.js).
// Модели с unlimited в лимит вообще не попадают. Каждый движок списывает
// против своего пула — фильтруем по e.model → provider.
function countableUsage(u, windowMs, provider, now) {
  const from = now - windowMs;
  const manualResetAt = windowMs === WINDOWS.short.ms ? Number(u.shortUsageResetAt || 0) : 0;
  return u.usage.filter((e) => {
    if (e.ts < from) return false;
    if (manualResetAt && e.ts <= manualResetAt) return false;
    if (UNLIMITED_MODELS.has(e.model)) return false;
    if (e.offerBonus === true) return false;
    return providerOfEvent(e) === provider;
  });
}

export function usedIn(u, windowMs, provider, now = Date.now()) {
  let sum = 0;
  for (const e of countableUsage(u, windowMs, provider, now)) sum += eventBillable(e, provider);
  return sum;
}

function combinedUsed(user, windowMs, now, joinedAt = 0) {
  const from = Math.max(now - windowMs, Number(joinedAt || 0));
  const manualResetAt = windowMs === WINDOWS.short.ms ? Number(user.shortUsageResetAt || 0) : 0;
  let sum = 0;
  for (const e of user.usage || []) {
    if (Number(e.ts || 0) < from || (manualResetAt && Number(e.ts || 0) <= manualResetAt) || UNLIMITED_MODELS.has(e.model) || e.offerBonus === true) continue;
    const provider = providerOfEvent(e);
    if (provider) sum += eventBillable(e, provider);
  }
  return sum;
}

function corporateUsageEvents(team, windowMs, now, onlyUserId = null) {
  const ids = onlyUserId ? [String(onlyUserId)] : team.members;
  const events = [];
  for (const id of ids) {
    const from = Math.max(now - windowMs, Number(team.memberSince?.[id] || team.createdAt || 0));
    const member = store.findUser(id);
    const manualResetAt = windowMs === WINDOWS.short.ms ? Number(member?.shortUsageResetAt || 0) : 0;
    for (const e of member?.usage || []) {
      if (Number(e.ts || 0) < from || (manualResetAt && Number(e.ts || 0) <= manualResetAt) || UNLIMITED_MODELS.has(e.model) || e.offerBonus === true) continue;
      if (providerOfEvent(e)) events.push(e);
    }
  }
  return events.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
}

function corporateWindowState(u, key, now) {
  const state = corporateStateOf(u, now);
  if (!state) return null;
  const win = WINDOWS[key];
  const isShort = key === 'short';
  const used = isShort
    ? combinedUsed(u, win.ms, now, state.team.memberSince?.[String(u.id)] || state.team.createdAt)
    : state.team.members.reduce((sum, id) => sum + combinedUsed(store.findUser(id) || { usage: [] }, win.ms, now, state.team.memberSince?.[id] || state.team.createdAt), 0);
  const limit = state.plan.limits[key];
  const events = corporateUsageEvents(state.team, win.ms, now, isShort ? u.id : null);
  const percent = Math.min(100, Math.round((used / limit) * 100));
  return {
    key, provider: 'corporate', title: isShort ? '5 часов · ваш лимит' : '7 дней · вся команда', shortTitle: win.shortTitle,
    percent, left: Math.max(0, 100 - percent), exceeded: used >= limit,
    resetAt: events.length ? Number(events[0].ts || now) + win.ms : now,
  };
}

// Когда окно освободится настолько, что запрос снова пройдёт
export function resetAt(u, windowMs, provider, now = Date.now()) {
  const inWindow = countableUsage(u, windowMs, provider, now).sort((a, b) => a.ts - b.ts);
  if (!inWindow.length) return now;
  return inWindow[0].ts + windowMs;
}

export function windowState(u, key, provider, now = Date.now()) {
  const corporate = corporateWindowState(u, key, now);
  if (corporate) return corporate;
  const plan = planOf(u);
  const win = WINDOWS[key];
  const limit = plan.limits[provider][key];
  if (limit === null) return null;
  const used = usedIn(u, win.ms, provider, now);
  const percent = Math.min(100, Math.round((used / limit) * 100));
  return {
    key,
    provider,
    title: win.title,
    shortTitle: win.shortTitle,
    percent,
    left: Math.max(0, 100 - percent),
    exceeded: used >= limit,
    resetAt: resetAt(u, win.ms, provider, now),
  };
}

// Лимиты одного провайдера (оба окна) — для проверки перед запросом к
// конкретной модели: используется её MODELS[key].provider.
export function checkLimits(u, provider, now = Date.now()) {
  const states = Object.keys(WINDOWS).map((k) => windowState(u, k, provider, now)).filter(Boolean);
  const blocked = states.find((s) => s.exceeded) || null;
  return { states, blocked };
}

// Лимиты сразу всех провайдеров — для /usage и админ-панели
export function checkAllLimits(u, now = Date.now()) {
  return Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, checkLimits(u, p, now)]));
}

// Генерация изображений (бета) — отдельный скользящий лимит "в сутки" (24ч),
// не смешивается с обычным токен-лимитом бота
export function imageLimitFor(u) {
  return IMAGE_DAILY_LIMITS[planOf(u).key] ?? IMAGE_DAILY_LIMITS.free;
}
export function imagesUsedToday(u, now = Date.now()) {
  const from = now - DAY;
  return (u.images || []).filter((ts) => ts >= from).length;
}
export function imageLimitState(u, now = Date.now()) {
  const limit = imageLimitFor(u);
  const used = imagesUsedToday(u, now);
  return { used, limit, left: Math.max(0, limit - used), exceeded: used >= limit };
}

export function bar(percent, size = 10) {
  const filled = Math.round((percent / 100) * size);
  return '▰'.repeat(Math.max(0, Math.min(size, filled))) + '▱'.repeat(Math.max(0, size - filled));
}

export function humanLeft(ms) {
  if (ms <= 0) return 'сейчас';
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} ч ${rm} мин` : `${h} ч`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} д ${rh} ч` : `${d} д`;
}
