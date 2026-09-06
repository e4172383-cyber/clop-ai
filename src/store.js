import { Redis } from '@upstash/redis';
import { DEFAULT_MODEL, DEFAULT_EFFORT, DAY, PLANS, PROMO_PRO_UNTIL } from './config.js';

const PAID_PLAN_KEYS = new Set(Object.keys(PLANS).filter((k) => k !== 'free'));
const USAGE_RETENTION = 60 * DAY;

// Пользователи/чаты/лимиты хранятся в Upstash Redis, а не на диске Render —
// диск бесплатного инстанса сбрасывается при каждом деплое/рестарте, Redis — нет.
const STORE_KEY = 'clop-ai:db';
const hasRedis = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const redis = hasRedis ? Redis.fromEnv() : null;
if (!hasRedis) {
  console.warn('[store] UPSTASH_REDIS_REST_URL/TOKEN не заданы — данные будут жить только в памяти процесса и потеряются при рестарте.');
}

let db = { users: {}, updatedAt: 0 };
let saveTimer = null;

export async function load() {
  if (redis) {
    try {
      const v = await redis.get(STORE_KEY);
      if (v && typeof v === 'object') { db = v; if (!db.users) db.users = {}; return db; }
    } catch (e) {
      console.error('[store] load failed', e.message);
    }
  }
  db = { users: {}, updatedAt: 0 };
  return db;
}

export async function save({ strict = false } = {}) {
  db.updatedAt = Date.now();
  if (!redis) return;
  try { await redis.set(STORE_KEY, db); } catch (e) {
    console.error('[store] save failed', e.message);
    if (strict) throw e;
  }
}

export function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save().catch((e) => console.error('[store] save failed', e.message)); }, 400);
}

// Сайты пользователей лежат отдельными ключами, а не внутри общего блоба:
// HTML бывает крупным, а блоб читается и пишется целиком
export function redisClient() { return redis; }

export function raw() { return db; }
export function allUsers() { return Object.values(db.users); }
export function findUserByUsername(username) {
  const uname = String(username || '').replace(/^@/, '').toLowerCase();
  if (!uname) return null;
  return allUsers().find((u) => (u.username || '').toLowerCase() === uname) || null;
}
export function findUser(id) { return db.users[String(id)] || null; }

export function getUser(from) {
  const id = String(from.id);
  let u = db.users[id];
  if (!u) {
    u = db.users[id] = {
      id,
      firstName: from.first_name || '',
      lastName: from.last_name || '',
      username: from.username || '',
      lang: from.language_code || '',
      // акция: новые пользователи тоже сразу на Pro, пока акция активна
      plan: Date.now() < PROMO_PRO_UNTIL ? 'pro' : 'free',
      proUntil: Date.now() < PROMO_PRO_UNTIL ? PROMO_PRO_UNTIL : 0,
      model: DEFAULT_MODEL,
      effort: DEFAULT_EFFORT,
      fast: false,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      activeChatId: null,
      chats: [],
      usage: [],
      images: [], // временные метки генераций картинок — для суточного лимита
      payments: [],
      stats: { requests: 0, tokens: 0, errors: 0 },
      pending: null,
    };
    saveSoon();
  }
  if (!u.images) u.images = []; // для пользователей, созданных до появления генерации картинок
  u.firstName = from.first_name || u.firstName;
  u.lastName = from.last_name || u.lastName;
  u.username = from.username || u.username;
  u.lastSeen = Date.now();
  if (!u.effort) u.effort = DEFAULT_EFFORT; // на случай пользователей, созданных до появления поля
  if (typeof u.fast !== 'boolean') u.fast = false;
  if (u.proUntil && u.proUntil < Date.now() && PAID_PLAN_KEYS.has(u.plan)) u.plan = 'free';
  return u;
}

export function displayName(u) {
  const n = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return n || (u.username ? '@' + u.username : 'ID ' + u.id);
}

export function newChat(u, title) {
  const chat = {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: title || 'Новый чат',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessionId: null,
    model: u.model,
    messages: [],
  };
  u.chats.unshift(chat);
  u.activeChatId = chat.id;
  saveSoon();
  return chat;
}

export function getChat(u, id) { return u.chats.find((c) => c.id === id) || null; }
export function liveChats(u) { return u.chats.filter((c) => !c.deleted); }

export function activeChat(u, create = true) {
  let c = u.activeChatId ? getChat(u, u.activeChatId) : null;
  if (c && c.deleted) c = null;
  if (!c && create) c = newChat(u);
  return c;
}

// Мягкое удаление — чат остаётся в базе (виден только в панели администратора
// с пометкой "удалён"), пользователю в боте больше не показывается
export function deleteChat(u, id) {
  const c = getChat(u, id);
  if (!c || c.deleted) return false;
  c.deleted = true;
  c.deletedAt = Date.now();
  if (u.activeChatId === id) u.activeChatId = liveChats(u)[0]?.id || null;
  saveSoon();
  return true;
}

export function pushMessage(chat, role, content, extra = {}) {
  chat.messages.push({ role, content, ts: Date.now(), ...extra });
  chat.updatedAt = Date.now();
  if (chat.messages.length === 1 && role === 'user') {
    chat.title = content.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Новый чат';
  }
  saveSoon();
}

export function addUsage(u, event) {
  u.usage.push(event);
  u.stats.requests += 1;
  u.stats.tokens += event.total || 0;
  const cutoff = Date.now() - USAGE_RETENTION;
  if (u.usage.length > 400) u.usage = u.usage.filter((e) => e.ts >= cutoff);
  saveSoon();
}

// Отмечает одну генерацию картинки (для суточного лимита) — храним только
// метки за последние 2 суток, дальше не нужны
export function addImageGeneration(u) {
  const now = Date.now();
  u.images.push(now);
  u.images = u.images.filter((ts) => now - ts < 2 * DAY);
  saveSoon();
}

// Акция: выдаёт Pro до PROMO_PRO_UNTIL всем, у кого сейчас нет платного
// тарифа с датой окончания позже этого момента (никого не понижает)
export function grantPromoToAll() {
  let granted = 0;
  for (const u of allUsers()) {
    if (!u.proUntil || u.proUntil < PROMO_PRO_UNTIL) {
      if (!PAID_PLAN_KEYS.has(u.plan) || u.plan === 'free') {
        u.plan = 'pro';
        u.proUntil = PROMO_PRO_UNTIL;
        granted++;
      } else if (u.proUntil < PROMO_PRO_UNTIL) {
        // на платном тарифе, но истекает раньше конца акции — продлеваем этим же тарифом
        u.proUntil = PROMO_PRO_UNTIL;
        granted++;
      }
    }
  }
  saveSoon();
  return granted;
}

export function grantPlan(u, planKey, days, payment) {
  const now = Date.now();
  // при смене тарифа (например Pro -> Max) остаток старого не переносим —
  // только продление того же тарифа копит дни
  const base = u.plan === planKey && u.proUntil && u.proUntil > now ? u.proUntil : now;
  u.proUntil = base + days * DAY;
  u.plan = planKey;
  if (payment) u.payments.push({ ...payment, ts: now });
  saveSoon();
}

/* Перенос всего нажитого с одного аккаунта на другой.

   Понадобилось для смены аккаунта Telegram: у бота ключ — числовой id, и при
   входе с другого аккаунта человек начинает с чистого листа. Переносим чаты,
   журнал обращений, счётчики, тариф и платежи.

   Правила слияния выбраны так, чтобы ничего не пропало и ничего не удвоилось:
   — чаты добавляются в конец, при совпадении номера принимающему выдаётся
     новый (номера собраны из времени и случайности, но проверить дешевле, чем
     потом искать пропавшую переписку);
   — журнал и платежи склеиваются по времени, счётчики складываются;
   — тариф берётся тот, что заканчивается позже: понижать нельзя.

   Исходный аккаунт после переноса пустеет — это перенос, а не копия. Личность
   (id, имя, username) у обоих остаётся своя. */
export function transferAccount(from, to) {
  if (!from || !to || from.id === to.id) return null;

  const занятые = new Set(to.chats.map((c) => c.id));
  const чаты = from.chats.map((c) => {
    if (!занятые.has(c.id)) { занятые.add(c.id); return c; }
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    занятые.add(id);
    return { ...c, id };
  });
  to.chats = to.chats.concat(чаты);

  to.usage = to.usage.concat(from.usage).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  to.payments = to.payments.concat(from.payments || []).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  to.images = (to.images || []).concat(from.images || []);

  to.stats = {
    requests: (to.stats.requests || 0) + (from.stats.requests || 0),
    tokens: (to.stats.tokens || 0) + (from.stats.tokens || 0),
    errors: (to.stats.errors || 0) + (from.stats.errors || 0),
  };

  // Тариф не понижаем: остаётся тот, что действует дольше
  const срок = (u) => (PAID_PLAN_KEYS.has(u.plan) ? (u.proUntil || 0) : 0);
  if (срок(from) > срок(to)) { to.plan = from.plan; to.proUntil = from.proUntil; }

  // Настройки переезжают, только если принимающий их не менял
  if (!to.activeChatId) to.activeChatId = чаты[0]?.id || null;
  if (from.model) to.model = from.model;
  if (from.effort) to.effort = from.effort;

  const итог = {
    chats: чаты.length,
    usage: from.usage.length,
    requests: from.stats.requests || 0,
    tokens: from.stats.tokens || 0,
    payments: (from.payments || []).length,
    plan: to.plan,
  };

  from.chats = [];
  from.usage = [];
  from.payments = [];
  from.images = [];
  from.stats = { requests: 0, tokens: 0, errors: 0 };
  from.activeChatId = null;
  from.plan = 'free';
  from.proUntil = 0;

  saveSoon();
  return итог;
}
