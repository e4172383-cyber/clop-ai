// Связь Telegram-бота с облачным API (clop-cloud-api на Render): выдача
// личного API-ключа пользователю и общий счётчик расхода токенов на аккаунт
// (бот + облачный API считаются вместе).
const CLOUD_API_URL = (process.env.CLOUD_API_URL || '').replace(/\/$/, '');
const INTERNAL_SECRET = process.env.CLOUD_INTERNAL_SECRET || '';
const TIMEOUT_MS = 4000;
// Бесплатный инстанс clop-cloud-api засыпает при простое — холодный старт
// занимает до ~50 сек. Для действий, которые прямо ждёт пользователь (выдача
// ключа), даём это время, а не 4 сек фонового таймаута.
const COLD_START_TIMEOUT_MS = 55_000;

function enabled() {
  return Boolean(CLOUD_API_URL && INTERNAL_SECRET);
}

async function call(path, opts = {}, timeoutMs = TIMEOUT_MS) {
  if (!enabled()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CLOUD_API_URL + path, {
      ...opts,
      headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET, ...(opts.headers || {}) },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Выдать пользователю его ключ (если уже есть — вернуть тот же). Пользователь
// сам ждёт ответа — даём время на холодный старт спящего сервиса.
export async function claimApiKey(telegramUserId, plan) {
  return call('/v1/claim', { method: 'POST', body: JSON.stringify({ telegramUserId: String(telegramUserId), plan }) }, COLD_START_TIMEOUT_MS);
}

// Сбросить ключ — старый перестаёт работать, выдаётся новый случайный.
export async function resetApiKey(telegramUserId, plan) {
  return call('/v1/reset', { method: 'POST', body: JSON.stringify({ telegramUserId: String(telegramUserId), plan }) }, COLD_START_TIMEOUT_MS);
}

// --- Несколько ключей на аккаунт (до 5) — для раздела «Мой API» на сайте ---

export async function listApiKeys(telegramUserId, plan) {
  return call('/v1/keys/list', { method: 'POST', body: JSON.stringify({ telegramUserId: String(telegramUserId), plan }) }, COLD_START_TIMEOUT_MS);
}

export async function createApiKey(telegramUserId, plan, label) {
  return call('/v1/keys/create', { method: 'POST', body: JSON.stringify({ telegramUserId: String(telegramUserId), plan, label }) }, COLD_START_TIMEOUT_MS);
}

export async function deleteApiKey(telegramUserId, key) {
  return call('/v1/keys/delete', { method: 'POST', body: JSON.stringify({ telegramUserId: String(telegramUserId), key }) }, COLD_START_TIMEOUT_MS);
}

// Прокси тестового запроса из «песочницы» на сайте: браузер не может стучаться
// в облако напрямую (CORS + светить ключ кросс-доменно), поэтому шлём отсюда.
// Возвращает статус, тело и время ответа — как есть, для отладки.
export async function proxyApiRequest({ path, apiKey, body, authHeader }) {
  if (!enabled()) return { ok: false, error: 'cloud disabled' };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COLD_START_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (authHeader === 'bearer') headers['authorization'] = `Bearer ${apiKey}`;
    else headers['x-api-key'] = apiKey;
    const res = await fetch(CLOUD_API_URL + path, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    const text = await res.text();
    return { ok: true, status: res.status, body: text, durationMs: Date.now() - started };
  } catch (e) {
    return { ok: false, error: String(e.message || e), durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// Отдельно от обычного расхода — просто "напомнить" облаку текущий тариф
// пользователя, даже если он давно не писал боту (чтобы plan не откатился
// на free по таймауту, пока подписка ещё активна).
export function syncPlan(telegramUserId, plan) {
  call('/v1/usage/report', { method: 'POST', body: JSON.stringify({ telegramUserId: String(telegramUserId), tokens: 0, plan }) }).catch(() => {});
}

// Текущий облачный расход пользователя (для показа в /usage вместе с локальным)
export async function cloudUsage(telegramUserId) {
  const res = await call(`/v1/usage/${telegramUserId}`, { method: 'GET' });
  return res || { short: 0, long: 0 };
}

export const cloudEnabled = enabled;
