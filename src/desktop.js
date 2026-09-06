import crypto from 'node:crypto';
import { raw as storeRaw, saveSoon } from './store.js';

/* Подключение настольного приложения Clop Code.

   Главное требование: в установщике не должно быть ни одного секрета —
   иначе, вскрыв .exe, любой получил бы доступ к чужим лимитам. Поэтому
   приложение ничего не знает заранее и получает personal-токен только после
   подтверждения в Telegram, по такой схеме:

     1. Приложение придумывает пару: короткий код и длинный секрет.
        На сервер уходит код и только ХЭШ секрета — сам секрет остаётся на
        компьютере пользователя.
     2. Пользователь открывает t.me/<бот>?start=desk_<код> и подтверждает.
        Бот привязывает код к своему Telegram-аккаунту.
     3. Приложение обменивает код + секрет на токен. Подглядевший код (он
        виден в ссылке) без секрета обменять его не может.

   Токен подписан HMAC и содержит id пользователя и id устройства. Устройство
   записано в профиле, поэтому любой токен отзывается из бота командой
   /devices — после отзыва подпись перестаёт приниматься.

   Модельных ключей у приложения нет вовсе: все запросы идут через сервер,
   который считает лимиты ровно так же, как бот и сайт. Красть из установщика
   нечего. */

const SECRET = process.env.WEB_SESSION_SECRET || process.env.WEB_PASSWORD
  || crypto.randomBytes(32).toString('hex');
if (!process.env.WEB_SESSION_SECRET && !process.env.WEB_PASSWORD) {
  console.warn('[desktop] WEB_SESSION_SECRET и WEB_PASSWORD не заданы — токены приложений слетят при рестарте.');
}

const PAIR_TTL_MS = 10 * 60_000;
const MAX_PENDING_PAIRS = 2_000;
// Пары входа хранятся вместе с основной базой. Render может перезапустить
// бесплатный инстанс между подтверждением в Telegram и возвращением в
// приложение; обычный Map в этот момент терял код и оставлял клиент ждать.
function pairs() {
  const db = storeRaw();
  if (!db.desktopPairs || typeof db.desktopPairs !== 'object' || Array.isArray(db.desktopPairs)) db.desktopPairs = {};
  return db.desktopPairs;
}

const b64 = (buf) => buf.toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url');

function cleanup() {
  const now = Date.now();
  const current = pairs();
  let changed = false;
  for (const [code, value] of Object.entries(current)) {
    if (!value || now - Number(value.createdAt || 0) > PAIR_TTL_MS) {
      delete current[code];
      changed = true;
    }
  }
  if (changed) saveSoon();
}

// Шаг 1: приложение объявляет код и хэш своего секрета
export function initPair(code, secretHash, device) {
  cleanup();
  if (!/^[a-z0-9]{10,32}$/i.test(String(code || ''))) return false;
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(secretHash || ''))) return false;
  const current = pairs();
  // Активный код нельзя перехватить, подменив для него хэш секрета.
  if (current[String(code)] || Object.keys(current).length >= MAX_PENDING_PAIRS) return false;
  current[String(code)] = {
    secretHash: String(secretHash),
    device: String(device || 'ПК').slice(0, 60),
    userId: null,
    createdAt: Date.now(),
  };
  saveSoon();
  return true;
}

export function pairInfo(code) {
  cleanup();
  const v = pairs()[String(code)];
  return v ? { device: v.device, claimed: Boolean(v.userId) } : null;
}

// Шаг 2: подтверждение из бота
export function claimPair(code, userId) {
  cleanup();
  const v = pairs()[String(code)];
  if (!v) return false;
  v.userId = String(userId);
  saveSoon();
  return true;
}

// Шаг 3: обмен кода и секрета на токен. Сравниваем хэши в постоянное время —
// иначе по времени ответа можно подбирать секрет посимвольно
export function redeemPair(code, secret) {
  cleanup();
  const current = pairs();
  const v = current[String(code)];
  if (!v || !v.userId) return null;
  const a = Buffer.from(sha256(secret));
  const b = Buffer.from(v.secretHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  delete current[String(code)];
  saveSoon();
  return { userId: v.userId, device: v.device };
}

export function signToken(userId, deviceId) {
  const payload = b64(Buffer.from(JSON.stringify({
    uid: String(userId), did: String(deviceId), iat: Date.now(),
  }), 'utf8'));
  const sig = b64(crypto.createHmac('sha256', SECRET).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyToken(token) {
  if (!token) return null;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;
  const expected = b64(crypto.createHmac('sha256', SECRET).update(payload).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return p.uid && p.did ? { uid: String(p.uid), did: String(p.did) } : null;
  } catch { return null; }
}

export const newDeviceId = () => crypto.randomBytes(8).toString('hex');

/* --- реестр устройств пользователя: он же список для отзыва --- */
export function addDevice(u, deviceId, name) {
  if (!Array.isArray(u.devices)) u.devices = [];
  u.devices.unshift({ id: deviceId, name: String(name || 'ПК').slice(0, 60), ts: Date.now(), lastSeen: Date.now() });
  u.devices = u.devices.slice(0, 20);
}

export function findDevice(u, deviceId) {
  return (u.devices || []).find((d) => d.id === deviceId) || null;
}

export function touchDevice(u, deviceId) {
  const d = findDevice(u, deviceId);
  if (d) d.lastSeen = Date.now();
}

export function removeDevice(u, deviceId) {
  const before = (u.devices || []).length;
  u.devices = (u.devices || []).filter((d) => d.id !== deviceId);
  return u.devices.length !== before;
}
