import crypto from 'node:crypto';

// Remote 1.1 Beta is deliberately ephemeral. A server restart ends every
// session and clears screenshots/commands, so a stale browser can never regain
// control after the desktop reconnects.
const devices = new Map();
const REQUEST_TTL_MS = 2 * 60_000;
const SESSION_TTL_MS = 15 * 60_000;
const ONLINE_TTL_MS = 15_000;
const RESULT_TTL_MS = 10 * 60_000;
const MAX_QUEUE = 50;

const keyOf = (userId, deviceId) => `${String(userId)}:${String(deviceId)}`;
const now = () => Date.now();
const randomId = (prefix) => `${prefix}${crypto.randomUUID()}`;

function cleanText(value, max) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

function get(userId, deviceId) {
  return devices.get(keyOf(userId, deviceId)) || null;
}

function active(device, at = now()) {
  if (!device?.session || device.session.expiresAt <= at) {
    if (device) device.session = null;
    return null;
  }
  return device.session;
}

function cleanupDevice(device, at = now()) {
  if (!device) return;
  if (device.request && device.request.expiresAt <= at) device.request = null;
  active(device, at);
  device.results = (device.results || []).filter((item) => at - item.finishedAt < RESULT_TTL_MS).slice(-100);
  device.queue = (device.queue || []).filter((item) => at - item.createdAt < RESULT_TTL_MS).slice(-MAX_QUEUE);
}

function publicRequest(request) {
  if (!request) return null;
  return { id: request.id, requestedAt: request.requestedAt, expiresAt: request.expiresAt, source: request.source };
}

function publicSession(session) {
  if (!session) return null;
  return { id: session.id, startedAt: session.startedAt, expiresAt: session.expiresAt };
}

function publicResult(result) {
  if (!result) return null;
  return {
    id: result.id,
    type: result.type,
    ok: result.ok,
    error: result.error || '',
    text: result.text || '',
    x: result.x,
    y: result.y,
    finishedAt: result.finishedAt,
    hasScreen: Boolean(result.screen),
  };
}

export function heartbeat({ userId, deviceId, name, version, enabled = true }) {
  const id = keyOf(userId, deviceId);
  let device = devices.get(id);
  if (!device) {
    device = {
      userId: String(userId), deviceId: String(deviceId), name: cleanText(name, 80) || 'Clop Code',
      version: cleanText(version, 30), enabled: Boolean(enabled), onlineAt: now(), request: null,
      session: null, queue: [], results: [], latestScreen: null,
    };
    devices.set(id, device);
  }
  device.name = cleanText(name, 80) || device.name;
  device.version = cleanText(version, 30) || device.version;
  device.enabled = Boolean(enabled);
  device.onlineAt = now();
  cleanupDevice(device);
  if (!device.enabled) {
    device.request = null;
    device.session = null;
    device.queue = [];
  }
  const session = active(device);
  const commands = session ? device.queue.filter((item) => !item.finishedAt && (!item.deliveredAt || now() - item.deliveredAt > 15_000)).slice(0, 1) : [];
  for (const item of commands) item.deliveredAt = now();
  return {
    ok: true,
    request: device.enabled ? publicRequest(device.request) : null,
    session: publicSession(session),
    commands: commands.map((item) => ({ id: item.id, type: item.type, payload: item.payload, createdAt: item.createdAt })),
  };
}

export function listDevices(userId) {
  const at = now();
  return [...devices.values()].filter((device) => device.userId === String(userId)).map((device) => {
    cleanupDevice(device, at);
    return {
      id: device.deviceId,
      name: device.name,
      version: device.version,
      enabled: device.enabled,
      online: at - device.onlineAt <= ONLINE_TTL_MS,
      lastSeen: device.onlineAt,
      request: publicRequest(device.request),
      session: publicSession(active(device, at)),
    };
  }).sort((a, b) => b.lastSeen - a.lastSeen);
}

export function requestAccess(userId, deviceId, source = 'Веб-версия Clop') {
  const device = get(userId, deviceId);
  cleanupDevice(device);
  if (!device || !device.enabled || now() - device.onlineAt > ONLINE_TTL_MS) throw new Error('Компьютер сейчас не подключён к Clop Remote.');
  if (active(device)) return { request: null, session: publicSession(device.session) };
  device.request = {
    id: randomId('request-'), source: cleanText(source, 80) || 'Веб-версия Clop',
    requestedAt: now(), expiresAt: now() + REQUEST_TTL_MS,
  };
  return { request: publicRequest(device.request), session: null };
}

export function decideAccess(userId, deviceId, requestId, allow) {
  const device = get(userId, deviceId);
  cleanupDevice(device);
  if (!device?.request || device.request.id !== String(requestId)) throw new Error('Запрос доступа истёк.');
  device.request = null;
  if (!allow) return { ok: true, session: null, denied: true };
  device.session = { id: randomId('remote-'), startedAt: now(), expiresAt: now() + SESSION_TTL_MS };
  device.queue = [];
  device.results = [];
  device.latestScreen = null;
  return { ok: true, session: publicSession(device.session) };
}

function normalizeCommand(type, payload = {}) {
  const kind = String(type || '');
  if (!['screenshot', 'click', 'type', 'key', 'prompt', 'stop'].includes(kind)) throw new Error('Неизвестная команда Remote.');
  if (kind === 'click') {
    const x = Number(payload.x), y = Number(payload.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 20_000 || y > 20_000) throw new Error('Некорректные координаты.');
    return { x, y };
  }
  if (kind === 'type') {
    const text = cleanText(payload.text, 12_000);
    if (!text) throw new Error('Введите текст.');
    return { text };
  }
  if (kind === 'prompt') {
    const text = cleanText(payload.text, 20_000);
    if (!text) throw new Error('Введите задачу для ИИ.');
    return { text };
  }
  if (kind === 'key') {
    const key = String(payload.key || '').toUpperCase();
    const allowed = new Set(['ENTER', 'TAB', 'ESC', 'BACKSPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'CTRL+A', 'CTRL+C', 'CTRL+V', 'CTRL+S', 'ALT+TAB']);
    if (!allowed.has(key)) throw new Error('Эта клавиша недоступна.');
    return { key };
  }
  return {};
}

export function queueCommand(userId, deviceId, sessionId, type, payload) {
  const device = get(userId, deviceId);
  const session = active(device);
  if (!device || !session || session.id !== String(sessionId) || now() - device.onlineAt > ONLINE_TTL_MS) throw new Error('Удалённый сеанс не активен.');
  if (device.queue.filter((item) => !item.finishedAt).length >= MAX_QUEUE) throw new Error('Очередь Remote заполнена.');
  const command = { id: randomId('command-'), type: String(type), payload: normalizeCommand(type, payload), createdAt: now(), deliveredAt: 0 };
  device.queue.push(command);
  return { id: command.id, type: command.type, createdAt: command.createdAt };
}

export function finishCommand(userId, deviceId, sessionId, result = {}) {
  const device = get(userId, deviceId);
  const session = active(device);
  if (!device || !session || session.id !== String(sessionId)) throw new Error('Удалённый сеанс не активен.');
  const command = device.queue.find((item) => item.id === String(result.id));
  if (!command) throw new Error('Команда Remote не найдена.');
  command.finishedAt = now();
  const screen = typeof result.screen === 'string' && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(result.screen) && result.screen.length <= 8_000_000
    ? result.screen : null;
  const entry = {
    id: command.id, type: command.type, ok: result.ok !== false,
    error: cleanText(result.error, 1_000), text: cleanText(result.text, 20_000),
    x: Number.isFinite(result.x) ? Math.round(result.x) : undefined,
    y: Number.isFinite(result.y) ? Math.round(result.y) : undefined,
    screen, finishedAt: now(),
  };
  if (screen) device.latestScreen = { commandId: command.id, data: screen, at: entry.finishedAt };
  device.results.push(entry);
  cleanupDevice(device);
  return { ok: true };
}

export function remoteStatus(userId, deviceId) {
  const device = get(userId, deviceId);
  cleanupDevice(device);
  if (!device) return null;
  return {
    device: listDevices(userId).find((item) => item.id === String(deviceId)) || null,
    results: device.results.slice(-30).reverse().map(publicResult),
    latestScreen: device.latestScreen,
  };
}

export function endSession(userId, deviceId, sessionId = '') {
  const device = get(userId, deviceId);
  if (!device) return false;
  const session = active(device);
  if (sessionId && session?.id !== String(sessionId)) return false;
  device.request = null;
  device.session = null;
  device.queue = [];
  device.latestScreen = null;
  return true;
}

export const constants = { REQUEST_TTL_MS, SESSION_TTL_MS, ONLINE_TTL_MS };
