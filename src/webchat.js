import crypto from 'node:crypto';

// Секрет для подписи cookie-сессии сайта-чата. Лучше задать WEB_SESSION_SECRET
// явно в Render — тогда сессии переживают рестарт процесса. Без него падаем
// на WEB_PASSWORD (тоже секрет), а без него вовсе — на случайный при старте
// (сессии слетят при следующем рестарте, но сервис не откажет запускаться).
const SESSION_SECRET = process.env.WEB_SESSION_SECRET || process.env.WEB_PASSWORD || crypto.randomBytes(32).toString('hex');
if (!process.env.WEB_SESSION_SECRET && !process.env.WEB_PASSWORD) {
  console.warn('[webchat] WEB_SESSION_SECRET и WEB_PASSWORD не заданы — сессии сайта-чата слетят при рестарте процесса.');
}

const SESSION_MAX_AGE_MS = 30 * 24 * 3600_000; // 30 дней
export const SESSION_COOKIE = 'clop_session';

function b64url(buf) { return buf.toString('base64url'); }

export function signSession(userId) {
  const payload = JSON.stringify({ uid: String(userId), exp: Date.now() + SESSION_MAX_AGE_MS });
  const payloadB64 = b64url(Buffer.from(payload, 'utf8'));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest());
  return `${payloadB64}.${sig}`;
}

export function verifySession(token) {
  if (!token) return null;
  const [payloadB64, sig] = String(token).split('.');
  if (!payloadB64 || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.uid || !payload.exp || Date.now() > payload.exp) return null;
    return payload.uid;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const header = req.headers['cookie'] || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function sessionUserId(req) {
  const cookies = parseCookies(req);
  return verifySession(cookies[SESSION_COOKIE]);
}

export function setSessionCookie(res, userId) {
  const token = signSession(userId);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}; Path=/; HttpOnly; SameSite=Lax`);
}
