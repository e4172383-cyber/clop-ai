import crypto from 'node:crypto';

// Одноразовые коды для входа на сайт-чат через Telegram: сайт создаёт код,
// пользователь открывает бота по диплинку t.me/bot?start=weblogin_<code>,
// бот привязывает код к своему id, сайт по коду забирает id и открывает сессию.
// Живёт только в памяти процесса — коды одноразовые и живут максимум 10 минут,
// персистентность не нужна (в отличие от store.js).
const CODE_TTL_MS = 10 * 60_000;
const codes = new Map(); // code -> { userId: string|null, createdAt: number }

function cleanup() {
  const now = Date.now();
  for (const [code, v] of codes) if (now - v.createdAt > CODE_TTL_MS) codes.delete(code);
}

export function createCode() {
  cleanup();
  const code = crypto.randomBytes(16).toString('hex');
  codes.set(code, { userId: null, createdAt: Date.now() });
  return code;
}

// Зовётся из bot.js, когда пользователь открыл /start weblogin_<code>
export function claimCode(code, userId) {
  const v = codes.get(code);
  if (!v || Date.now() - v.createdAt > CODE_TTL_MS) return false;
  v.userId = String(userId);
  return true;
}

// Зовётся с сайта при поллинге статуса — не удаляет код (может звать ещё раз),
// возвращает userId, если бот уже привязал
export function peekClaimed(code) {
  const v = codes.get(code);
  if (!v || Date.now() - v.createdAt > CODE_TTL_MS) return null;
  return v.userId;
}

// Разово выдаёт userId и удаляет код — вызывается один раз при выпуске сессии,
// чтобы один код нельзя было переиспользовать
export function consumeCode(code) {
  const v = codes.get(code);
  codes.delete(code);
  if (!v || Date.now() - v.createdAt > CODE_TTL_MS) return null;
  return v.userId;
}
