import { Redis } from '@upstash/redis';
import { DEFAULT_MODEL, DEFAULT_EFFORT, DAY, PLANS, PROMO_PRO_UNTIL, LIMITED_OFFER, corporatePlan } from './config.js';

const PAID_PLAN_KEYS = new Set(Object.keys(PLANS).filter((k) => k !== 'free'));
const USAGE_RETENTION = 60 * DAY;
const MODEL_MIGRATIONS = Object.freeze({
  'clop-3-1-pulsar': 'clop-4-pulsar',
  'clop-3-1-opus': 'clop-4-pro',
  'clop-3-1-haiku': 'clop-4-flash',
});

// Пользователи/чаты/лимиты хранятся в Upstash Redis, а не на диске Render —
// диск бесплатного инстанса сбрасывается при каждом деплое/рестарте, Redis — нет.
const STORE_KEY = 'clop-ai:db';
// node:test наследует переменные окружения разработчика. Никогда не разрешаем
// тестовому процессу подключаться к рабочей базе, даже если в оболочке лежат
// настоящие UPSTASH_* значения.
const hasRedis = !process.env.NODE_TEST_CONTEXT
  && Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const redis = hasRedis ? Redis.fromEnv() : null;
if (!hasRedis) {
  console.warn('[store] UPSTASH_REDIS_REST_URL/TOKEN не заданы — данные будут жить только в памяти процесса и потеряются при рестарте.');
}

let db = { users: {}, teams: {}, customBots: {}, pendingGrants: {}, updatedAt: 0 };
let saveTimer = null;
let lastBackupSlot = null;

function migrateModelSelections() {
  let changed = false;
  for (const user of Object.values(db.users || {})) {
    if (MODEL_MIGRATIONS[user.model]) {
      user.model = MODEL_MIGRATIONS[user.model];
      changed = true;
    }
    for (const chat of user.chats || []) {
      if (!MODEL_MIGRATIONS[chat.model]) continue;
      chat.model = MODEL_MIGRATIONS[chat.model];
      chat.sessionId = null;
      changed = true;
    }
  }
  return changed;
}

export async function load() {
  if (redis) {
    try {
      const v = await redis.get(STORE_KEY);
      if (v && typeof v === 'object') {
        db = v;
        if (!db.users) db.users = {};
        if (!db.teams) db.teams = {};
        if (!db.customBots) db.customBots = {};
        if (!db.pendingGrants) db.pendingGrants = {};
        if (migrateModelSelections()) await redis.set(STORE_KEY, db);
        return db;
      }
      throw new Error('рабочий ключ clop-ai:db отсутствует или повреждён');
    } catch (e) {
      console.error('[store] load failed', e.message);
      // Пустой запуск с последующим минутным save уничтожил бы рабочие данные.
      // Лучше не поднять контейнер, чем перезаписать базу пустым объектом.
      throw e;
    }
  }
  db = { users: {}, teams: {}, customBots: {}, pendingGrants: {}, updatedAt: 0 };
  return db;
}

export async function save({ strict = false } = {}) {
  db.updatedAt = Date.now();
  if (!redis) return;
  try {
    // Раз в шесть часов сохраняем копию предыдущего рабочего блока на семь
    // дней. Это даёт точки восстановления без бесконечного роста Redis.
    const slot = Math.floor(Date.now() / (6 * 60 * 60_000));
    if (slot !== lastBackupSlot) {
      const previous = await redis.get(STORE_KEY);
      if (previous && typeof previous === 'object' && Object.keys(previous.users || {}).length) {
        await redis.set(`clop-ai:db:backup:${slot}`, previous, { ex: 7 * DAY / 1000 });
      }
      lastBackupSlot = slot;
    }
    await redis.set(STORE_KEY, db);
  } catch (e) {
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
export function findUserByPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return allUsers().find((u) => String(u.phone || '').replace(/\D/g, '') === digits) || null;
}
export function findUser(id) { return db.users[String(id)] || null; }

function applyPendingGrant(u) {
  const key = String(u.username || '').replace(/^@/, '').toLowerCase();
  const grant = key && db.pendingGrants?.[key];
  if (!grant) return false;
  const now = Date.now();
  if (grant.expiresAt && grant.expiresAt <= now) {
    delete db.pendingGrants[key];
    saveSoon();
    return false;
  }
  if (grant.offer) {
    u.limitedOffer = {
      id: LIMITED_OFFER.id,
      claimedAt: now,
      until: now + LIMITED_OFFER.durationMs,
      usedByModel: Object.fromEntries(LIMITED_OFFER.models.map((model) => [model, 0])),
      grantedBy: 'pending-admin',
      grantReason: String(grant.reason || 'manual-offer').slice(0, 80),
    };
  }
  if (grant.planKey && PLANS[grant.planKey] && grant.planKey !== 'free') {
    grantPlan(u, grant.planKey, Math.min(366, Math.max(1, Number(grant.days) || 30)), {
      source: 'pending_admin_grant',
      reason: String(grant.reason || 'manual-plan').slice(0, 80),
    });
  }
  delete db.pendingGrants[key];
  saveSoon();
  return true;
}

export function queueUsernameGrant(username, grant) {
  const key = String(username || '').replace(/^@/, '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,64}$/.test(key)) return false;
  if (!db.pendingGrants) db.pendingGrants = {};
  db.pendingGrants[key] = {
    ...grant,
    queuedAt: Date.now(),
    expiresAt: Number(grant?.expiresAt) || Date.now() + 30 * DAY,
  };
  saveSoon();
  return true;
}

function mergeByKey(older = [], newer = [], keyOf) {
  const values = new Map();
  for (const value of [...older, ...newer]) {
    const key = keyOf(value);
    if (key) values.set(key, value);
  }
  return [...values.values()];
}

// Восстановление добавляет отсутствующие исторические данные, но не откатывает
// более свежие поля уже работающего аккаунта. Вызывается только защищённым
// внутренним маршрутом с локально проверенного снимка.
export function mergeRecovery(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.users || typeof snapshot.users !== 'object') {
    throw new Error('invalid recovery snapshot');
  }
  const entries = Object.entries(snapshot.users);
  if (!entries.length || entries.length > 10_000) throw new Error('unsafe recovery user count');
  let addedUsers = 0;
  let mergedUsers = 0;
  for (const [sourceId, historical] of entries) {
    if (!historical || typeof historical !== 'object') continue;
    const id = String(historical.id || sourceId || '');
    if (!id) continue;
    const current = db.users[id];
    if (!current) {
      db.users[id] = historical;
      addedUsers++;
      continue;
    }
    const combined = { ...historical, ...current, id };
    combined.chats = mergeByKey(historical.chats, current.chats, (c) => String(c?.id || ''));
    combined.usage = mergeByKey(historical.usage, current.usage, (e) => String(e?.requestId || `${e?.ts || 0}:${e?.model || ''}:${e?.total || 0}`));
    combined.payments = mergeByKey(historical.payments, current.payments, (p) => String(p?.id || `${p?.ts || 0}:${p?.source || ''}:${p?.stars || 0}`));
    combined.stats = {
      requests: Math.max(Number(historical.stats?.requests) || 0, Number(current.stats?.requests) || 0),
      tokens: Math.max(Number(historical.stats?.tokens) || 0, Number(current.stats?.tokens) || 0),
      errors: Math.max(Number(historical.stats?.errors) || 0, Number(current.stats?.errors) || 0),
    };
    db.users[id] = combined;
    mergedUsers++;
  }
  db.teams = { ...(snapshot.teams || {}), ...(db.teams || {}) };
  db.customBots = { ...(snapshot.customBots || {}), ...(db.customBots || {}) };
  db.pendingGrants = { ...(snapshot.pendingGrants || {}), ...(db.pendingGrants || {}) };
  // Если восстановленный снимок вернул пользователя, применяем ожидавшую его
  // выдачу сразу, а не второй раз при следующем сообщении.
  for (const user of Object.values(db.users)) applyPendingGrant(user);
  return { addedUsers, mergedUsers, totalUsers: Object.keys(db.users).length };
}

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
      bonusBalance: 0,
      bonusTransactions: [],
      bonusReservations: [],
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
  if (!Number.isFinite(u.bonusBalance)) u.bonusBalance = 0;
  if (!Array.isArray(u.bonusTransactions)) u.bonusTransactions = [];
  if (!Array.isArray(u.bonusReservations)) u.bonusReservations = [];
  if (u.proUntil && u.proUntil < Date.now() && PAID_PLAN_KEYS.has(u.plan)) u.plan = 'free';
  applyPendingGrant(u);
  return u;
}

export function displayName(u) {
  const n = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return n || (u.username ? '@' + u.username : 'ID ' + u.id);
}

export function markStarted(u) {
  if (!u.startedAt) u.startedAt = Date.now();
  u.lastSeen = Date.now();
  saveSoon();
}

export function savePhone(u, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return false;
  u.phone = digits;
  saveSoon();
  return true;
}

export function findUserByIdentifier(identifier) {
  const value = String(identifier || '').trim();
  if (!value) return null;
  if (value.startsWith('@')) return findUserByUsername(value);
  const digits = value.replace(/\D/g, '');
  if (/^\d+$/.test(value) && db.users[value]) return findUser(value);
  return findUserByPhone(digits) || (/^\d+$/.test(value) ? findUser(value) : findUserByUsername(value));
}

export function activeTeamFor(u, now = Date.now()) {
  const team = u?.teamId && db.teams?.[u.teamId];
  if (!team || Number(team.until || 0) <= now || !team.members?.includes(String(u.id))) return null;
  return corporatePlan(team.tier) ? team : null;
}

export function ownedTeam(u) {
  return Object.values(db.teams || {}).find((team) => team.ownerId === String(u.id)) || null;
}

export function grantCorporatePlan(owner, tier, days, payment) {
  const plan = corporatePlan(tier);
  if (!plan) throw new Error('Корпоративные тарифы временно недоступны');
  let team = ownedTeam(owner);
  const now = Date.now();
  if (!team) {
    team = { id: 't' + now.toString(36) + Math.random().toString(36).slice(2, 7), ownerId: String(owner.id), tier, until: 0, members: [String(owner.id)], memberSince: { [String(owner.id)]: now }, invites: [], payments: [], createdAt: now };
    db.teams[team.id] = team;
  }
  if (!team.members.includes(String(owner.id))) team.members.unshift(String(owner.id));
  if (!team.memberSince) team.memberSince = {};
  if (!team.memberSince[String(owner.id)]) team.memberSince[String(owner.id)] = now;
  const base = team.tier === tier && team.until > now ? team.until : now;
  team.tier = tier;
  team.until = base + days * DAY;
  if (payment) team.payments.push({ ...payment, ts: now });
  owner.teamId = team.id;
  saveSoon();
  return team;
}

export function inviteToTeam(owner, target, now = Date.now()) {
  const team = activeTeamFor(owner, now);
  if (!team || team.ownerId !== String(owner.id)) return { ok: false, error: 'У вас нет активного корпоративного тарифа.' };
  const plan = corporatePlan(team.tier);
  if (!target?.startedAt) return { ok: false, error: 'Пользователь ещё не нажал /start в боте.' };
  if (String(target.id) === String(owner.id)) return { ok: false, error: 'Вы уже состоите в этой команде.' };
  if (activeTeamFor(target, now)) return { ok: false, error: 'Пользователь уже состоит в активной команде.' };
  if (team.members.length >= plan.maxUsers) return { ok: false, error: `В команде уже максимум участников: ${plan.maxUsers}.` };
  const previous = team.invites.find((x) => x.userId === String(target.id) && x.status === 'pending' && x.expiresAt > now);
  if (previous) return { ok: true, invite: previous, reused: true, team };
  const invite = { id: 'i' + now.toString(36) + Math.random().toString(36).slice(2, 7), userId: String(target.id), status: 'pending', createdAt: now, expiresAt: now + 7 * DAY };
  team.invites.push(invite);
  saveSoon();
  return { ok: true, invite, team };
}

export function respondToTeamInvite(user, inviteId, accept, now = Date.now()) {
  const team = Object.values(db.teams || {}).find((x) => x.invites?.some((i) => i.id === inviteId && i.userId === String(user.id)));
  const invite = team?.invites?.find((i) => i.id === inviteId && i.userId === String(user.id));
  if (!team || !invite || invite.status !== 'pending' || invite.expiresAt <= now) return { ok: false, error: 'Приглашение устарело или уже обработано.' };
  if (!accept) { invite.status = 'declined'; invite.respondedAt = now; saveSoon(); return { ok: true, accepted: false, team }; }
  const plan = corporatePlan(team.tier);
  if (!plan || team.until <= now) return { ok: false, error: 'Корпоративный тариф уже закончился.' };
  if (activeTeamFor(user, now)) return { ok: false, error: 'Вы уже состоите в активной команде.' };
  if (team.members.length >= plan.maxUsers) return { ok: false, error: 'В команде больше нет свободных мест.' };
  team.members.push(String(user.id));
  if (!team.memberSince) team.memberSince = {};
  team.memberSince[String(user.id)] = now;
  user.teamId = team.id;
  invite.status = 'accepted';
  invite.respondedAt = now;
  saveSoon();
  return { ok: true, accepted: true, team };
}

export function removeTeamMember(owner, targetId) {
  const team = activeTeamFor(owner);
  const id = String(targetId);
  if (!team || team.ownerId !== String(owner.id)) return { ok: false, error: 'У вас нет активной команды.' };
  if (id === team.ownerId) return { ok: false, error: 'Владелец не может удалить себя из команды.' };
  if (!team.members.includes(id)) return { ok: false, error: 'Пользователь не состоит в вашей команде.' };
  team.members = team.members.filter((x) => x !== id);
  if (team.memberSince) delete team.memberSince[id];
  const target = findUser(id);
  if (target?.teamId === team.id) delete target.teamId;
  saveSoon();
  return { ok: true, team };
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

export function addBalance(u, micros, payment) {
  const value = Math.max(0, Math.round(Number(micros || 0)));
  if (!u.balanceTransactions) u.balanceTransactions = [];
  if (payment?.chargeId && u.balanceTransactions.some((entry) => entry.chargeId === payment.chargeId)) return Math.max(0, Math.round(Number(u.balanceMicros || 0)));
  u.balanceMicros = Math.max(0, Math.round(Number(u.balanceMicros || 0))) + value;
  u.balanceTransactions.push({ type: 'topup', micros: value, ts: Date.now(), ...payment });
  saveSoon();
  return u.balanceMicros;
}

export function chargeBalance(u, micros, details = {}) {
  const value = Math.max(0, Math.round(Number(micros || 0)));
  if (!u.billingCharges) u.billingCharges = [];
  if (details.requestId && u.billingCharges.some((x) => x.requestId === details.requestId)) return { ok: true, duplicate: true, balanceMicros: u.balanceMicros || 0 };
  const balance = Math.max(0, Math.round(Number(u.balanceMicros || 0)));
  if (value > balance) return { ok: false, balanceMicros: balance };
  u.balanceMicros = balance - value;
  u.billingCharges.push({ micros: value, ts: Date.now(), ...details });
  if (u.billingCharges.length > 500) u.billingCharges = u.billingCharges.slice(-500);
  saveSoon();
  return { ok: true, balanceMicros: u.balanceMicros };
}

function sweepBonusReservations(u, now = Date.now()) {
  if (!Array.isArray(u.bonusReservations)) u.bonusReservations = [];
  const active = [];
  let released = false;
  for (const reservation of u.bonusReservations) {
    if (Number(reservation.expiresAt || 0) > now) active.push(reservation);
    else {
      u.bonusBalance = Math.max(0, Math.floor(Number(u.bonusBalance || 0))) + Math.max(0, Math.floor(Number(reservation.amount || 0)));
      released = true;
    }
  }
  u.bonusReservations = active;
  if (released) saveSoon();
}

export function bonusBalance(u, now = Date.now()) {
  sweepBonusReservations(u, now);
  return Math.max(0, Math.floor(Number(u.bonusBalance || 0)));
}

export function bonusReport(u, now = Date.now()) {
  return {
    balance: bonusBalance(u, now),
    transactions: (u.bonusTransactions || []).slice(-100).reverse(),
  };
}

export function addBonus(u, amount, details = {}) {
  const value = Math.max(0, Math.floor(Number(amount || 0)));
  if (!value) return bonusBalance(u);
  if (!Array.isArray(u.bonusTransactions)) u.bonusTransactions = [];
  if (details.sourceId && u.bonusTransactions.some((entry) => entry.sourceId === details.sourceId)) return bonusBalance(u);
  u.bonusBalance = bonusBalance(u) + value;
  u.bonusTransactions.push({ type: 'credit', amount: value, ts: Date.now(), ...details });
  if (u.bonusTransactions.length > 500) u.bonusTransactions = u.bonusTransactions.slice(-500);
  saveSoon();
  return u.bonusBalance;
}

export function spendBonus(u, amount, details = {}) {
  const value = Math.max(0, Math.floor(Number(amount || 0)));
  const balance = bonusBalance(u);
  if (!value || value > balance) return { ok: false, balance };
  u.bonusBalance = balance - value;
  u.bonusTransactions.push({ type: 'debit', amount: -value, ts: Date.now(), ...details });
  if (u.bonusTransactions.length > 500) u.bonusTransactions = u.bonusTransactions.slice(-500);
  saveSoon();
  return { ok: true, balance: u.bonusBalance };
}

export function reserveBonus(u, maximum, ttlMs = 15 * 60_000) {
  const amount = Math.min(bonusBalance(u), Math.max(0, Math.floor(Number(maximum || 0))));
  if (!amount) return null;
  const reservation = { id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9), amount, expiresAt: Date.now() + ttlMs };
  u.bonusBalance -= amount;
  u.bonusReservations.push(reservation);
  saveSoon();
  return reservation;
}

export function consumeBonusReservation(u, id, details = {}) {
  sweepBonusReservations(u);
  const index = u.bonusReservations.findIndex((entry) => entry.id === String(id || ''));
  if (index < 0) return null;
  const [reservation] = u.bonusReservations.splice(index, 1);
  u.bonusTransactions.push({ type: 'debit', amount: -reservation.amount, ts: Date.now(), ...details });
  saveSoon();
  return reservation.amount;
}

export function releaseBonusReservation(u, id) {
  const index = (u.bonusReservations || []).findIndex((entry) => entry.id === String(id || ''));
  if (index < 0) return 0;
  const [reservation] = u.bonusReservations.splice(index, 1);
  u.bonusBalance = Math.max(0, Math.floor(Number(u.bonusBalance || 0))) + reservation.amount;
  saveSoon();
  return reservation.amount;
}

export function resetFiveHourUsage(u, details = {}) {
  u.shortUsageResetAt = Date.now();
  if (!Array.isArray(u.bonusTransactions)) u.bonusTransactions = [];
  u.bonusTransactions.push({ type: 'limit-reset', amount: 0, ts: u.shortUsageResetAt, ...details });
  saveSoon();
  return u.shortUsageResetAt;
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

export function goTrialState(u, now = Date.now()) {
  const startedAt = Number(u?.goTrialStartedAt || 0);
  const endsAt = Number(u?.goTrialEndsAt || 0);
  const active = Boolean(startedAt && endsAt > now && u?.plan === 'go' && Number(u?.proUntil || 0) >= endsAt);
  const paidPersonal = Boolean(PAID_PLAN_KEYS.has(u?.plan) && Number(u?.proUntil || 0) > now && !active);
  const team = u ? activeTeamFor(u, now) : null;
  return {
    eligible: Boolean(u && !startedAt && !paidPersonal && !team),
    active,
    used: Boolean(startedAt),
    startedAt,
    endsAt,
    reason: startedAt ? 'already_used' : team ? 'team_subscription' : paidPersonal ? 'active_subscription' : null,
  };
}

// Пробный GO выдаётся сервером один раз на Telegram-аккаунт. Отметка остаётся
// после окончания, поэтому повторный запрос из другого клиента не продлевает срок.
export function activateGoTrial(u, now = Date.now()) {
  const state = goTrialState(u, now);
  if (!state.eligible) return { ok: false, ...state };
  const endsAt = now + DAY;
  u.goTrialStartedAt = now;
  u.goTrialEndsAt = endsAt;
  u.plan = 'go';
  u.proUntil = endsAt;
  if (!Array.isArray(u.planEvents)) u.planEvents = [];
  u.planEvents.push({ type: 'go_trial', startedAt: now, endsAt });
  saveSoon();
  return { ok: true, ...goTrialState(u, now) };
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
  to.bonusBalance = bonusBalance(to) + bonusBalance(from);
  to.bonusTransactions = (to.bonusTransactions || []).concat(from.bonusTransactions || []).sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-500);
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

  // Активное ограниченное предложение следует за аккаунтом вместе с чатами.
  // Если оно есть у обоих аккаунтов, сохраняем запись с более поздним сроком
  // и не обнуляем уже потраченный бонус.
  const fromOffer = from.limitedOffer;
  const toOffer = to.limitedOffer;
  if (fromOffer && (!toOffer || Number(fromOffer.until || 0) > Number(toOffer.until || 0))) {
    to.limitedOffer = {
      ...fromOffer,
      usedByModel: fromOffer.usedByModel ? { ...fromOffer.usedByModel } : undefined,
    };
  } else if (fromOffer && toOffer && fromOffer.id === toOffer.id) {
    to.limitedOffer.used = Math.max(Number(toOffer.used || 0), Number(fromOffer.used || 0));
    const keys = new Set([...Object.keys(fromOffer.usedByModel || {}), ...Object.keys(toOffer.usedByModel || {})]);
    if (keys.size) {
      to.limitedOffer.usedByModel = Object.fromEntries([...keys].map((key) => [
        key,
        Math.max(Number(toOffer.usedByModel?.[key] || 0), Number(fromOffer.usedByModel?.[key] || 0)),
      ]));
    }
  }

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
  from.bonusBalance = 0;
  from.bonusTransactions = [];
  from.bonusReservations = [];
  from.images = [];
  from.stats = { requests: 0, tokens: 0, errors: 0 };
  from.activeChatId = null;
  from.plan = 'free';
  from.proUntil = 0;
  delete from.limitedOffer;

  saveSoon();
  return итог;
}
