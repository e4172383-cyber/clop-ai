const BASE_URL = String(process.env.VM_MANAGER_URL || '').replace(/\/$/, '');
const INTERNAL_SECRET = process.env.VM_INTERNAL_SECRET || '';

export function enabled() {
  return Boolean(BASE_URL && INTERNAL_SECRET);
}

async function request(path, userId, body = {}) {
  if (!enabled()) return { ok: false, available: false, error: 'Виртуальные машины пока недоступны на этом сервере.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vm-secret': INTERNAL_SECRET,
      },
      body: JSON.stringify({ ...body, userId: String(userId) }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    return { ...data, ok: response.ok && data.ok !== false, available: true };
  } catch (error) {
    return { ok: false, available: false, error: error?.name === 'AbortError' ? 'Сервис VM не ответил вовремя.' : 'Сервис VM временно недоступен.' };
  } finally {
    clearTimeout(timer);
  }
}

export const status = (userId) => request('/v1/status', userId);
export const start = (userId) => request('/v1/start', userId);
export const stop = (userId) => request('/v1/stop', userId);
export const command = (userId, commandText) => request('/v1/command', userId, { command: String(commandText || '') });
