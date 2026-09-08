import http from 'node:http';
import fs from 'node:fs';
import { BILLING_VERSION } from './token-accounting.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WEB_PORT, WEB_HOST, PUBLIC_URL, MODELS, PLANS, PROVIDERS, DEFAULT_MODEL, DEFAULT_EFFORT, EFFORTS, DAY, BOT_NAME, ADMIN_IDS, freeGoActive, FREE_GO_UNTIL, FREE_GO_PLAN, MODEL_PROMO, modelPromoActive, CORPORATE_PLANS, corporatePlansReady } from './config.js';
import * as store from './store.js';
import * as sites from './sites.js';
import * as desk from './desktop.js';
import * as vision from './vision.js';
import * as relay from './relay.js';
import * as support from './support.js';

// Ответ оператора должен дойти до человека в бота — иначе заявка теряет
// смысл. Ошибку доставки глушим: панель не должна падать из-за Telegram.
async function notifyUser(userId, text) {
  try {
    const { sendMessage } = await import('./telegram.js');
    await sendMessage(userId, text);
  } catch (e) {
    console.warn('[поддержка] не удалось уведомить', userId, e.message);
  }
}
import { extractOffice } from './docs.js';

// Картинки едут в теле запроса в base64, поэтому предел на сообщение крупный:
// четыре снимка по 8 МБ плюс текст
const MAX_MESSAGE_BYTES = 26_000_000;
import { planOf, checkAllLimits, checkLimits, effortOf, allowedEffortOptions, imageLimitState, humanLeft } from './limits.js';
import { getSiteKey } from './sitekey.js';
import { askModel, modelAvailableTo, modelOf, modelPlans } from './bot.js';
import { addOfferUsage, claimOffer, offerActiveFor, offerState } from './limited-offer.js';
import { getBotUsername } from './botinfo.js';
import { createCode, peekClaimed, consumeCode } from './weblogin.js';
import { setSessionCookie, sessionUserId } from './webchat.js';
import { extractFiles, filesForJson } from './files.js';
import { buildZip } from './zip.js';
import { listApiKeys, createApiKey, deleteApiKey, proxyApiRequest, cloudEnabled } from './cloud.js';
import * as chatArtifacts from './chatartifacts.js';
import { API_PRICES, STARS_PER_USD, MIN_TOPUP_STARS, MAX_TOPUP_STARS, chargeMicros, microsToUsd } from './billing.js';
import { voiceLimitState, startVoiceSession, chargeVoiceHeartbeat, stopVoiceSession } from './voice-limits.js';
import { healthCheck as gptHealthCheck } from './gpt.js';
import { healthCheck as kimiHealthCheck } from './kimi.js';
import { publicServiceStatus } from './provider-status.js';
import { BOT_TEMPLATES, listCustomBots, createCustomBot, deleteCustomBot, handleCustomBotWebhook } from './custom-bots.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const WEB_PASSWORD = process.env.WEB_PASSWORD || '';

function publicBug(ticket) {
  return {
    id: ticket.id,
    status: ticket.status,
    description: ticket.messages?.[0]?.text || '',
    platform: ticket.platform || '',
    created: ticket.created,
    updated: ticket.updated,
    reward: ticket.reward || null,
  };
}

function checkBasicAuth(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return false;
  const [, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  return pass === WEB_PASSWORD;
}

// Беседы веб-сайта (hm550863.webhm.cloud) — отдельные от Telegram-бота,
// живут только в памяти процесса, ключ — sessionId, который браузер сайта
// хранит у себя (localStorage) и присылает обратно для продолжения диалога.
const siteChats = new Map();
// Один desktop-запрос на пользователя: параллельные устройства не могут
// одновременно пройти проверку одного и того же остатка лимита.
const desktopBusy = new Set();
let statusCache = null;
let statusCacheAt = 0;
let statusPending = null;

function publicProviderUsageSamples(now = Date.now()) {
  const cutoff = now - 60 * DAY;
  const result = [];
  for (const user of store.allUsers()) {
    for (const event of user.usage || []) {
      const provider = MODELS[event.model]?.provider;
      if ((provider !== 'gpt' && provider !== 'kimi' && provider !== 'clop') || Number(event.ts) < cutoff) continue;
      result.push({
        provider,
        at: Number(event.ts) || 0,
        durationMs: Number(event.durationMs) || 0,
        // У старых записей отдельного output ещё могло не быть. Для них
        // используем общее число только как запасной источник скорости.
        outputTokens: Number(event.output) || Number(event.total) || 0,
      });
    }
  }
  return result.sort((a, b) => b.at - a.at).slice(0, 400);
}

function currentPublicStatus() {
  const now = Date.now();
  // Единый серверный снимок для всех клиентов. Обновляется раз в минуту:
  // разные браузеры больше не подменяют его своей локальной скоростью сети.
  if (statusCache && now - statusCacheAt < 60_000) return Promise.resolve(statusCache);
  if (statusPending) return statusPending;
  const started = Date.now();
  statusPending = Promise.all([
    gptHealthCheck().catch(() => ({ ok: false })),
    kimiHealthCheck().catch(() => ({ ok: false })),
  ]).then(([gptHealth, kimiHealth]) => {
    statusCache = publicServiceStatus({
      gptHealth,
      kimiHealth,
      processingMs: Date.now() - started,
      usageSamples: publicProviderUsageSamples(),
    });
    statusCacheAt = Date.now();
    return statusCache;
  }).finally(() => { statusPending = null; });
  return statusPending;
}

function siteChat(sessionId) {
  const id = sessionId && siteChats.has(sessionId) ? sessionId : crypto.randomUUID();
  if (!siteChats.has(id)) siteChats.set(id, { id, sessionId: null, messages: [] });
  return siteChats.get(id);
}

function readJsonBody(req, maxBytes = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(obj));
}

function attachmentDisposition(name) {
  const utf8Name = Buffer.from(String(name || 'file.txt'), 'utf8').toString('utf8');
  const encoded = encodeURIComponent(utf8Name).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}

const DESKTOP_DOWNLOADS = new Set([
  'Clop-Code-Setup-2.0.6.exe',
  'Clop-Code-Setup-2.0.8.exe',
  'Clop-Code-Setup-2.0.9.exe',
  'Clop-Code-Setup-2.0.10.exe',
  'Clop-Code-Setup-2.0.11.exe',
  'Clop-Code-Setup-2.1.1.exe',
  'Clop-Code-Setup-2.3.0.exe',
  'Clop-Code-Setup-2.3.1.exe',
  'Clop-Code-Setup-2.3.3.exe',
  'Clop-Code-2.0.6-linux-x64.tar.xz',
  'Clop-Code-2.0.9-linux-x64.tar.xz',
  'Clop-Code-2.0.10-linux-x64.tar.xz',
  'Clop-Code-2.0.11-linux-x64.tar.xz',
  'Clop-Code-2.1.1-linux-x64.tar.xz',
  'Clop-Code-2.3.0-linux-x64.tar.xz',
  'Clop-Code-2.3.1-linux-x64.tar.xz',
  'Clop-Code-2.3.3-linux-x64.tar.xz',
  'Clop-AI-Mobile-1.0.0.apk',
  'Clop-AI-Mobile-1.0.1.apk',
  'Clop-AI-Mobile-1.0.2.apk',
  'Clop-AI-Mobile-1.0.3.apk',
  'Clop-AI-Mobile-1.0.4.apk',
]);

function serveDesktopFile(req, res, name, { download = false } = {}) {
  const full = path.join(PUBLIC, download ? 'downloads' : '', name);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  const stat = fs.statSync(full);
  const contentType = name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
  const headers = download ? {
    'content-disposition': attachmentDisposition(name),
    'cache-control': 'public, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
  } : { 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' };
  const range = download && req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'content-type': contentType,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      ...headers,
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(full, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': contentType, 'content-length': stat.size, ...headers });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(full).pipe(res);
}

// Публичный срез лимитов для интерфейсов: проценты и время сброса нужны для
// выбора модели, а фактические токены и объёмы тарифа остаются на сервере.
function publicLimits(u) {
  const all = checkAllLimits(u);
  const state = (s) => ({
    title: s.title,
    percent: s.percent,
    exceeded: s.exceeded,
    resetAt: s.resetAt,
  });
  return Object.fromEntries(Object.entries(all).map(([provider, result]) => [
    provider,
    Object.fromEntries(result.states.map((s) => [s.key, state(s)])),
  ]));
}

function publicUsage(tokens, durationMs) {
  const count = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  const input = count(tokens?.input);
  const output = count(tokens?.output);
  return {
    usage: { input, output, total: count(tokens?.total) || input + output },
    durationMs: count(durationMs),
  };
}

function publicArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts.map((artifact) => {
    const item = {
      name: String(artifact?.name || 'file.txt'),
      size: Math.max(0, Number(artifact?.size) || 0),
    };
    if (typeof artifact?.mimeType === 'string') item.mimeType = artifact.mimeType;
    if (/^\/chat\/api\/artifact\?id=[A-Za-z0-9_-]{20,40}\.\d+$/.test(String(artifact?.downloadUrl || ''))) {
      item.downloadUrl = artifact.downloadUrl;
    }
    if (Number.isFinite(artifact?.expiresAt)) item.expiresAt = artifact.expiresAt;
    return item;
  });
}

function publicChatMessage(message) {
  const artifacts = publicArtifacts(message.artifacts);
  return {
    role: message.role,
    content: typeof message.displayText === 'string' ? message.displayText : message.content,
    ts: message.ts,
    ...(artifacts.length ? { artifacts } : {}),
  };
}

// FILE-маркеры нужны только для разбора ответа. В истории модели оставляем
// содержимое файлов обычным текстом, а интерфейсу отдаём отдельный displayText.
// Так контекст не теряется и при продолжении того же чата из Telegram.
function assistantTranscript(displayText, files, truncatedFile = null) {
  if (!files.length && !truncatedFile) return displayText;
  const fileBlocks = files.map((file) => [
    `Созданный файл «${file.path}»:`,
    '--- начало файла ---',
    file.content,
    '--- конец файла ---',
  ].join('\n'));
  if (truncatedFile) {
    fileBlocks.push([
      `Незавершённый файл «${truncatedFile.path}» (ответ модели оборвался):`,
      '--- начало частичного файла ---',
      truncatedFile.content || '[частичный текст отсутствует]',
      '--- конец частичного файла ---',
    ].join('\n'));
  }
  return [displayText, fileBlocks.join('\n\n')].filter(Boolean).join('\n\n');
}

function availableModelOf(u, requestedKey) {
  const candidate = MODELS[requestedKey];
  return modelAvailableTo(u, candidate) ? candidate : modelOf(u);
}

// Общий секрет с clop-cloud-api (та же переменная, что бот шлёт наружу в
// cloud.js как CLOUD_INTERNAL_SECRET — сверяем в обе стороны одним значением)
function checkInternalSecret(req) {
  const header = req.headers['x-internal-secret'] || '';
  const real = process.env.CLOUD_INTERNAL_SECRET || '';
  if (!real) return false;
  const a = Buffer.from(String(header).padEnd(real.length, '\0'));
  const b = Buffer.from(real.padEnd(real.length, '\0'));
  return header && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function checkSiteKey(req) {
  const header = req.headers['x-site-key'] || '';
  const real = getSiteKey();
  const a = Buffer.from(String(header).padEnd(real.length, '\0'));
  const b = Buffer.from(real.padEnd(real.length, '\0'));
  return header && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function buildStats() {
  const now = Date.now();
  const users = store.allUsers();
  const events = [];
  for (const u of users) for (const e of u.usage) events.push({ ...e, userId: u.id, userName: store.displayName(u) });
  events.sort((a, b) => b.ts - a.ts);

  const since = (ms) => events.filter((e) => e.ts >= now - ms);
  const sum = (arr, f = (e) => e.total || 0) => arr.reduce((s, e) => s + f(e), 0);

  const dayEvents = since(DAY);
  const weekEvents = since(7 * DAY);

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    const key = d.toISOString().slice(0, 10);
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const to = from + DAY;
    const inDay = events.filter((e) => e.ts >= from && e.ts < to);
    days.push({
      date: key,
      label: d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
      tokens: sum(inDay),
      requests: inDay.length,
    });
  }

  const byModel = {};
  for (const key of Object.keys(MODELS)) byModel[key] = { key, title: MODELS[key].title, tokens: 0, requests: 0 };
  for (const e of events) if (byModel[e.model]) { byModel[e.model].tokens += e.total || 0; byModel[e.model].requests += 1; }

  const pick = (s) => ({ percent: s.percent, resetAt: s.resetAt });
  const userRows = users.map((u) => {
    const all = checkAllLimits(u, now);
    return {
      id: u.id,
      name: store.displayName(u),
      username: u.username ? '@' + u.username : '',
      plan: planOf(u).key,
      modelPromo: modelPromoActive()
        ? { title: MODEL_PROMO.title, until: MODEL_PROMO.until, models: MODEL_PROMO.models }
        : null,
      proUntil: u.proUntil || 0,
      model: (MODELS[u.model] || {}).short || '—',
      chats: u.chats.filter((c) => !c.deleted).length,
      deletedChats: u.chats.filter((c) => c.deleted).length,
      messages: u.chats.reduce((s, c) => s + c.messages.length, 0),
      requests: u.stats.requests,
      errors: u.stats.errors,
      tokens: u.stats.tokens,
      lastSeen: u.lastSeen,
      createdAt: u.createdAt,
      // Все движки — раздельные пулы. Окно может быть отключено тарифом,
      // поэтому публикуем только реально действующие окна.
      ...Object.fromEntries(Object.entries(all).map(([provider, result]) => [
        provider,
        Object.fromEntries(result.states.map((state) => [state.key, pick(state)])),
      ])),
    };
  }).sort((a, b) => b.lastSeen - a.lastSeen);

  const payments = [];
  for (const u of users) for (const p of u.payments || []) payments.push({ ...p, userId: u.id, userName: store.displayName(u) });
  payments.sort((a, b) => b.ts - a.ts);

  return {
    botName: BOT_NAME,
    now,
    totals: {
      users: users.length,
      byPlan: Object.fromEntries(Object.keys(PLANS).filter((k) => k !== 'free')
        .map((k) => [k, userRows.filter((u) => u.plan === k).length])),
      activeToday: users.filter((u) => u.lastSeen >= now - DAY).length,
      requestsToday: dayEvents.length,
      tokensToday: sum(dayEvents),
      tokensWeek: sum(weekEvents),
      requestsTotal: events.length,
      tokensTotal: sum(events),
      errors: users.reduce((s, u) => s + (u.stats.errors || 0), 0),
      starsTotal: payments.reduce((s, p) => s + (p.stars || 0), 0),
      costUsd: sum(events, (e) => e.costUsd || 0),
    },
    days,
    models: Object.values(byModel),
    users: userRows,
    payments: payments.slice(0, 30),
    recent: events.slice(0, 60),
  };
}

// Полная переписка пользователя для панели администратора — включая мягко
// удалённые (deleted:true) чаты, которые сам пользователь в боте уже не видит.
function buildUserDetail(id) {
  const u = store.findUser(id);
  if (!u) return null;
  const plan = planOf(u);
  return {
    id: u.id,
    name: store.displayName(u),
    username: u.username ? '@' + u.username : '',
    plan: plan.key,
    proUntil: u.proUntil || 0,
    createdAt: u.createdAt,
    lastSeen: u.lastSeen,
    model: (MODELS[u.model] || {}).title || u.model,
    stats: u.stats,
    // Приватность: содержимое переписки (заголовок чата и текст сообщений)
    // на сайте не отдаём вообще — только метаданные (счётчики, время, модель)
    chats: [...u.chats].sort((a, b) => b.updatedAt - a.updatedAt).map((c) => ({
      id: c.id,
      model: (MODELS[c.model] || {}).title || c.model,
      messagesCount: c.messages.length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      deleted: Boolean(c.deleted),
      deletedAt: c.deletedAt || null,
    })),
    // Журнал обращений: время, модель и расход. Текста запросов здесь нет и
    // быть не должно — это счётчики, а не переписка.
    usage: [...(u.usage || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0)).map((e) => ({
      ts: e.ts || 0,
      model: (MODELS[e.model] || {}).title || e.model || '',
      effort: e.effort || '',
      input: e.input || 0,
      output: e.output || 0,
      total: e.total || 0,
      ok: e.ok !== false,
      durationMs: e.durationMs || 0,
      source: e.source || '',
    })),
    payments: [...(u.payments || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0)),
  };
}

export function startWeb({ reloadEachRequest = false, askModelImpl = askModel } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Лёгкий пинг для само-разогрева на Render (без пароля, без AI) — просто
    // подтверждает, что процесс жив, ничего не считает и не трогает store
    if (url.pathname === '/health') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'x-clop-revision': String(process.env.RENDER_GIT_COMMIT || 'local').slice(0, 40),
      });
      return res.end('ok');
    }
    const customBotHook = /^\/custom-bot\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (customBotHook && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        if (reloadEachRequest) await store.load();
        const handled = await handleCustomBotWebhook(
          decodeURIComponent(customBotHook[1]),
          decodeURIComponent(customBotHook[2]),
          String(req.headers['x-telegram-bot-api-secret-token'] || ''),
          body,
        );
        return sendJson(res, handled ? 200 : 404, { ok: handled });
      }).catch((e) => sendJson(res, 200, { ok: false, error: String(e.message || e) }));
      return;
    }
    if (url.pathname === '/status.json' && req.method === 'GET') {
      currentPublicStatus().then((status) => sendJson(res, 200, status)).catch(() => sendJson(res, 200, publicServiceStatus({
        gptHealth: { ok: false },
        kimiHealth: { ok: false },
        processingMs: 0,
      })));
      return;
    }
    if (url.pathname === '/releases.json' && req.method === 'GET') {
      return sendJson(res, 200, {
        desktop: {
          version: '2.3.3',
          url: `${PUBLIC_URL || 'https://clop-ai.onrender.com'}/downloads/Clop-Code-Setup-2.3.3.exe`,
          windowsUrl: `${PUBLIC_URL || 'https://clop-ai.onrender.com'}/downloads/Clop-Code-Setup-2.3.3.exe`,
          linuxUrl: `${PUBLIC_URL || 'https://clop-ai.onrender.com'}/downloads/Clop-Code-2.3.3-linux-x64.tar.xz`,
        },
        android: { version: '1.0.4', url: `${PUBLIC_URL || 'https://clop-ai.onrender.com'}/downloads/Clop-AI-Mobile-1.0.4.apk` },
      });
    }

    // Чат для сайта hm550863.webhm.cloud — стучится сюда через PHP-прокси
    // на хостинге (ключ x-site-key никогда не попадает в браузер посетителя)
    if (url.pathname === '/api/site-chat' && req.method === 'POST') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!checkSiteKey(req)) return sendJson(res, 401, { ok: false, error: 'invalid site key' });
      readJsonBody(req).then(async (body) => {
        const prompt = String(body.message || '').trim().slice(0, 8000);
        if (!prompt) return sendJson(res, 400, { ok: false, error: 'message is required' });
        const chat = siteChat(body.sessionId);
        chat.messages.push({ role: 'user', content: prompt });
        try {
          const r = await askModelImpl({ chat, model: MODELS[DEFAULT_MODEL], effortKey: DEFAULT_EFFORT, prompt, fast: false });
          if (!r.ok) return sendJson(res, 502, { ok: false, error: r.error, sessionId: chat.id });
          chat.gptThreadId = r.threadId;
          chat.messages.push({ role: 'assistant', content: r.text });
          return sendJson(res, 200, { ok: true, reply: r.text, sessionId: chat.id });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: String(e.message || e).slice(0, 300) });
        }
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }
    if (url.pathname === '/api/site-chat' && req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-site-key');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.writeHead(204);
      return res.end();
    }

    // Единый источник правды по лимитам и тарифу. Раньше clop-cloud-api вёл
    // СВОЮ копию таблицы лимитов — она разъехалась с ботом (там остались
    // старые общие цифры без разделения Claude/GPT), и пользователю писало
    // «лимит исчерпан», когда он не исчерпан. Теперь облако спрашивает здесь.
    if (url.pathname === '/internal/limit-check' && req.method === 'POST') {
      if (!checkInternalSecret(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      readJsonBody(req).then(async (body) => {
        const userId = String(body.telegramUserId || '');
        const provider = PROVIDERS[body.provider] ? body.provider : 'claude';
        if (!userId) return sendJson(res, 400, { ok: false, error: 'telegramUserId required' });
        if (reloadEachRequest) await store.load();
        const u = store.findUser(userId);
        if (!u) return sendJson(res, 404, { ok: false, error: 'user not found' });
        if (body.billingMode === 'payg') {
          const priced = API_PRICES[String(body.model || '')];
          const allowed = Boolean(priced && Number(u.balanceMicros || 0) > 0);
          return sendJson(res, 200, { ok: true, allowed, plan: 'coderplus', billingMode: 'payg', reason: allowed ? null : priced ? 'Недостаточно средств. Пополните баланс минимум на $1.' : 'Для этой модели не настроена цена.' });
        }
        const plan = planOf(u);
        const { blocked } = checkLimits(u, provider);
        return sendJson(res, 200, {
          ok: true,
          allowed: !blocked,
          plan: plan.key,
          reason: blocked
            ? `Лимит ${PROVIDERS[provider].title} на ${blocked.title} исчерпан — обновится через ${humanLeft(blocked.resetAt - Date.now())}.`
            : null,
        });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    // clop-cloud-api зовёт сюда после каждого успешного запроса через личный
    // API (/v1/ask, /v1/messages, /v1/chat/completions) — иначе расход через
    // API не попадает в лимит бота (Claude-пул), хотя должен считаться вместе
    if (url.pathname === '/internal/api-usage' && req.method === 'POST') {
      if (!checkInternalSecret(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      readJsonBody(req).then(async (body) => {
        const userId = String(body.telegramUserId || '');
        const modelKey = String(body.model || '');
        const billable = Number(body.billable || 0);
        const requestId = String(body.requestId || '').slice(0, 128);
        if (!userId || !Number.isFinite(billable) || billable <= 0 || !requestId) {
          return sendJson(res, 400, { ok: false, error: 'telegramUserId, billable and requestId required' });
        }
        if (reloadEachRequest) await store.load();
        const u = store.findUser(userId);
        if (!u) return sendJson(res, 404, { ok: false, error: 'user not found' });
        if (body.billingMode === 'payg') {
          const micros = chargeMicros(modelKey, body.usage || { input: billable });
          if (micros == null) return sendJson(res, 400, { ok: false, error: 'model price missing' });
          const charged = store.chargeBalance(u, micros, { source: 'cloud-api', requestId, model: modelKey });
          if (!charged.ok) return sendJson(res, 402, { ok: false, error: 'insufficient balance' });
          await store.save({ strict: true });
          return sendJson(res, 200, { ok: true, chargedUsd: microsToUsd(micros), balanceUsd: microsToUsd(charged.balanceMicros), duplicate: charged.duplicate === true });
        }
        if (u.usage.some((event) => event.source === 'cloud-api' && event.requestId === requestId)) {
          await store.save({ strict: true });
          return sendJson(res, 200, { ok: true, duplicate: true });
        }
        store.addUsage(u, {
          ts: Date.now(), chatId: null, model: MODELS[modelKey] ? modelKey : DEFAULT_MODEL,
          effort: null, plan: planOf(u).key,
          input: 0, output: 0, cacheWrite: 0, cacheRead: 0,
          total: billable, billable, billingVersion: BILLING_VERSION,
          costUsd: 0, durationMs: 0, source: 'cloud-api', requestId,
        });
        await store.save({ strict: true });
        return sendJson(res, 200, { ok: true });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    // --- Второй сайт: полноценный чат с выбором модели, вход только через
    // Telegram-диплинк (не по паролю) — тот же аккаунт/лимиты, что и в боте.
    if (url.pathname === '/chat') {
      const full = path.join(PUBLIC, 'chat.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return fs.createReadStream(full).pipe(res);
    }

    // Файлы устанавливаемого приложения (PWA) обязаны быть публичными: они
    // лежат до проверки пароля панели, иначе браузер получает 401 и приложение
    // не устанавливается. Данных пользователя в них нет.
    const PWA_FILES = {
      '/manifest.webmanifest': 'application/manifest+json; charset=utf-8',
      '/sw.js': 'text/javascript; charset=utf-8',
      '/icon-180.png': 'image/png',
      '/icon-192.png': 'image/png',
      '/icon-512.png': 'image/png',
    };
    // Картинки с сайта и из приложения приходят строками data:image/...;base64.
    // Кладём их на диск, отдаём модели и обязательно прибираем за собой.
    // Документ Microsoft 365 приезжает тем же способом, что и картинка, —
    // строкой base64. Текст из него достаём сами и приклеиваем к запросу.
    const officePrefix = (doc) => {
      if (!doc || !doc.name || !doc.data) return '';
      const m = /^data:[^;]*;base64,([\s\S]+)$/.exec(String(doc.data));
      if (!m) return '';
      let buf;
      try { buf = Buffer.from(m[1], 'base64'); } catch { return ''; }
      if (!buf.length || buf.length > 12_000_000) return '';
      const ext = String(doc.name).split('.').pop().toLowerCase();
      if (['txt', 'md', 'json', 'csv'].includes(ext)) {
        if (buf.includes(0)) return `Пользователь прислал документ «${doc.name}», но это не текстовый файл.\n\n`;
        const raw = buf.toString('utf8');
        const text = raw.length > 120_000 ? raw.slice(0, 120_000) + '\n\n[документ обрезан]' : raw;
        return `Пользователь прислал документ «${doc.name}», вот его текст:\n---\n${text}\n---\n\n`;
      }
      const r = extractOffice(buf, doc.name);
      if (!r.ok) return `Пользователь прислал документ «${doc.name}», но прочитать его не вышло: ${r.error}.\n\n`;
      const text = r.text.length > 120_000 ? r.text.slice(0, 120_000) + '\n\n[документ обрезан]' : r.text;
      return `Пользователь прислал документ «${doc.name}», вот его текст:\n---\n${text}\n---\n\n`;
    };

    const stashImages = (list) => vision.stash(
      (Array.isArray(list) ? list : []).slice(0, vision.MAX_IMAGES)
        .map((x) => vision.fromDataUrl(x)).filter(Boolean),
    );

    /* --- Ретранслятор GPT ---
       Домашний компьютер владельца сам приходит за заданиями: сервер к нему не
       стучится, поэтому ни белого адреса, ни проброса портов не нужно. Вход
       один — общий секрет RELAY_TOKEN, без него маршруты не отвечают вовсе. */
    if (url.pathname.startsWith('/relay/')) {
      const key = String(req.headers['x-relay-token'] || '')
        || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!relay.authorized(key)) return sendJson(res, 401, { ok: false, error: 'нет доступа' });

      // Длинное ожидание: держим соединение, пока не появится задание
      if (url.pathname === '/relay/pull' && req.method === 'GET') {
        relay.pull(url.searchParams.get('agent'))
          .then((job) => (job ? sendJson(res, 200, { ok: true, job }) : sendJson(res, 200, { ok: true, job: null })))
          .catch((e) => sendJson(res, 500, { ok: false, error: String(e.message || e) }));
        return;
      }

      // Готовый кусок ответа — чтобы человек видел текст, не дожидаясь конца
      if (url.pathname === '/relay/delta' && req.method === 'POST') {
        readJsonBody(req, MAX_MESSAGE_BYTES)
          .then((b) => sendJson(res, 200, { ok: relay.delta(b.id, b.text) }))
          .catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
        return;
      }

      if (url.pathname === '/relay/result' && req.method === 'POST') {
        readJsonBody(req, MAX_MESSAGE_BYTES)
          .then((b) => sendJson(res, 200, { ok: relay.deliver(b.id, b.result || {}) }))
          .catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
        return;
      }

      if (url.pathname === '/relay/status' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, ...relay.status() });
      }

      return sendJson(res, 404, { ok: false, error: 'нет такого маршрута' });
    }

    /* --- Настольное приложение Clop Code ---
       Маршруты открыты (приложение не знает пароля панели), но каждый требует
       либо пары код+секрет, либо личного токена. Модельных ключей приложение
       не получает никогда: думает сервер, лимиты считает он же. */
    if (url.pathname.startsWith('/desk/')) {
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const authed = async () => {
        const t = desk.verifyToken(bearer);
        if (!t) return null;
        if (reloadEachRequest) await store.load();
        const u = store.findUser(t.uid);
        // Отозванное устройство: подпись ещё верна, но доступа больше нет
        if (!u || !desk.findDevice(u, t.did)) return null;
        desk.touchDevice(u, t.did);
        return u;
      };

      if (url.pathname === '/desk/init' && req.method === 'POST') {
        readJsonBody(req).then(async (b) => {
          const ok = desk.initPair(b.code, b.secretHash, b.device);
          if (ok) await store.save({ strict: true });
          return sendJson(res, 200, { ok, bot: getBotUsername() });
        }).catch(() => sendJson(res, 400, { ok: false }));
        return;
      }

      if (url.pathname === '/desk/poll' && req.method === 'POST') {
        readJsonBody(req).then(async (b) => {
          const info = desk.pairInfo(b.code);
          if (!info) return sendJson(res, 404, { ok: false, error: 'код устарел' });
          if (!info.claimed) return sendJson(res, 200, { ok: false, pending: true });
          const got = desk.redeemPair(b.code, b.secret);
          if (!got) return sendJson(res, 403, { ok: false, error: 'секрет не подошёл' });
          if (reloadEachRequest) await store.load();
          const u = store.findUser(got.userId);
          if (!u) return sendJson(res, 404, { ok: false, error: 'аккаунт не найден' });
          const deviceId = desk.newDeviceId();
          desk.addDevice(u, deviceId, got.device);
          await store.save();
          return sendJson(res, 200, {
            ok: true, token: desk.signToken(u.id, deviceId),
            user: { name: store.displayName(u), plan: planOf(u).title },
          });
        }).catch(() => sendJson(res, 400, { ok: false }));
        return;
      }

      if (url.pathname === '/desk/me' && req.method === 'GET') {
        authed().then((u) => {
          if (!u) return sendJson(res, 401, { ok: false, error: 'нужен вход' });
          const plan = planOf(u);
          const limits = publicLimits(u);
          return sendJson(res, 200, {
            ok: true, name: store.displayName(u), plan: plan.title, planKey: plan.key,
            // Desktop показывает полный каталог: недоступные модели остаются
            // видимыми с замком, поэтому пользователь понимает состав тарифов.
            models: Object.values(MODELS).map((m) => ({
              key: m.key,
              title: m.title,
              provider: m.provider,
              description: m.desc || '',
              available: modelAvailableTo(u, m),
              plans: modelPlans(m),
              supportsEffort: m.supportsEffort !== false,
              limitMultiplier: m.limitMultiplier || 1,
            })),
            model: modelOf(u).key,
            limits,
            // Список сил мышления, доступных на тарифе: приложение
            // показывает выбор, а не гадает и не врёт про недоступное
            efforts: allowedEffortOptions(u, modelOf(u)).map((k) => ({ key: k, title: EFFORTS[k].title })),
            promo: modelPromoActive()
              ? { title: MODEL_PROMO.title, until: MODEL_PROMO.until, models: MODEL_PROMO.models }
              : null,
            effort: effortOf(u, modelOf(u)).key,
            fast: u.fast === true,
            voice: voiceLimitState(u, plan.key),
            limitedOffer: offerState(u),
            bonuses: store.bonusReport(u),
          });
        }).catch(() => sendJson(res, 500, { ok: false }));
        return;
      }

      if (url.pathname === '/desk/bugs' && req.method === 'GET') {
        authed().then((u) => {
          if (!u) return sendJson(res, 401, { ok: false, error: 'нужен вход' });
          return sendJson(res, 200, {
            ok: true,
            bugs: support.userTickets(u.id).filter((ticket) => ticket.type === 'bug').map(publicBug),
            bonuses: store.bonusReport(u),
          });
        }).catch(() => sendJson(res, 500, { ok: false }));
        return;
      }

      if (url.pathname === '/desk/bugs' && req.method === 'POST') {
        readJsonBody(req, 20_000).then(async (body) => {
          const u = await authed();
          if (!u) return sendJson(res, 401, { ok: false, error: 'нужен вход' });
          const ticket = support.createBugReport(u, body.description, 'Clop Code');
          await store.save({ strict: true });
          for (const adminId of ADMIN_IDS) notifyUser(adminId, `🐞 Новый баг №${ticket.id} от ${store.displayName(u)}${u.username ? ` (@${u.username})` : ''}\n\n${ticket.messages[0].text.slice(0, 900)}`);
          return sendJson(res, 201, { ok: true, bug: publicBug(ticket) });
        }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
        return;
      }

      if (url.pathname === '/desk/logout' && req.method === 'POST') {
        authed().then(async (u) => {
          if (!u) return sendJson(res, 401, { ok: false });
          desk.removeDevice(u, desk.verifyToken(bearer).did);
          await store.save();
          return sendJson(res, 200, { ok: true });
        }).catch(() => sendJson(res, 500, { ok: false }));
        return;
      }

      if (url.pathname === '/desk/offer/claim' && req.method === 'POST') {
        authed().then(async (u) => {
          if (!u) return sendJson(res, 401, { ok: false, error: 'нужен вход' });
          const offer = claimOffer(u);
          if (!offer) return sendJson(res, 410, { ok: false, error: 'Предложение завершилось.' });
          await store.save({ strict: true });
          return sendJson(res, 200, { ok: true, limitedOffer: offer });
        }).catch((e) => sendJson(res, 500, { ok: false, error: String(e.message || e) }));
        return;
      }

      if (url.pathname === '/desk/profile' && req.method === 'POST') {
        readJsonBody(req, 20_000).then(async (body) => {
          const u = await authed();
          if (!u) return sendJson(res, 401, { ok: false, error: 'нужен вход' });
          const plan = planOf(u);
          if (body.model) {
            const chosen = MODELS[String(body.model)];
            if (!chosen) return sendJson(res, 400, { ok: false, error: 'Неизвестная модель.' });
            if (!modelAvailableTo(u, chosen)) return sendJson(res, 403, { ok: false, error: 'Модель недоступна на этом тарифе.' });
            u.model = chosen.key;
          }
          const model = modelOf(u);
          if (body.effort) {
            if (!allowedEffortOptions(u, model).includes(String(body.effort))) {
              return sendJson(res, 403, { ok: false, error: 'Этот уровень усиления недоступен.' });
            }
            u.effort = String(body.effort);
          }
          if (typeof body.fast === 'boolean') u.fast = body.fast;
          await store.save();
          return sendJson(res, 200, {
            ok: true,
            model: modelOf(u).key,
            effort: effortOf(u, modelOf(u)).key,
            fast: u.fast === true,
          });
        }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
        return;
      }

      if (url.pathname === '/desk/voice/start' && req.method === 'POST') {
        authed().then(async (u) => {
          if (!u) return sendJson(res, 401, { ok: false, error: 'нужен вход' });
          const plan = planOf(u);
          const id = crypto.randomUUID();
          const session = startVoiceSession(u, plan.key, id);
          if (!session) return sendJson(res, 429, { ok: false, error: 'Недельный лимит голосового ассистента исчерпан.', voice: voiceLimitState(u, plan.key) });
          await store.save({ strict: true });
          return sendJson(res, 200, { ok: true, sessionId: id, voice: voiceLimitState(u, plan.key) });
        }).catch((e) => sendJson(res, 500, { ok: false, error: String(e.message || e) }));
        return;
      }

      if (url.pathname === '/desk/voice/heartbeat' && req.method === 'POST') {
        readJsonBody(req, 10_000).then(async (body) => {
          const u = await authed();
          if (!u) return sendJson(res, 401, { ok: false, error: 'нужен вход' });
          const state = chargeVoiceHeartbeat(u, planOf(u).key, body.sessionId);
          if (!state) return sendJson(res, 409, { ok: false, error: 'Голосовая сессия не найдена.' });
          if (state.ended) delete u.voiceSessionId;
          await store.save({ strict: true });
          return sendJson(res, 200, { ok: true, voice: state });
        }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
        return;
      }

      if (url.pathname === '/desk/voice/stop' && req.method === 'POST') {
        readJsonBody(req, 10_000).then(async (body) => {
          const u = await authed();
          if (!u) return sendJson(res, 401, { ok: false, error: 'нужен вход' });
          const state = stopVoiceSession(u, planOf(u).key, body.sessionId);
          await store.save({ strict: true });
          return sendJson(res, 200, { ok: true, voice: state });
        }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
        return;
      }

      if (url.pathname === '/desk/chat' && req.method === 'POST') {
        // Не буферизуем большой base64-body от заведомо неавторизованного
        // клиента. Полная проверка устройства и пользователя идёт ниже.
        if (!desk.verifyToken(bearer)) return sendJson(res, 401, { ok: false, error: 'нужен вход' });
        readJsonBody(req, MAX_MESSAGE_BYTES).then(async (body) => {
          const u = await authed();
          if (!u) return sendJson(res, 401, { ok: false, error: 'нужен вход' });
          let prompt = String(body.text || '').trim().slice(0, 200_000);
          const hasImages = Array.isArray(body.images) && body.images.length > 0;
          const hasOffice = Boolean(body.office && body.office.name && body.office.data);
          if (!prompt && !hasImages && !hasOffice) return sendJson(res, 400, { ok: false, error: 'пустой запрос' });
          if (!prompt) prompt = 'Проанализируй приложенный файл и выполни задачу по его содержимому.';

          const busyKey = String(u.id);
          if (desktopBusy.has(busyKey)) return sendJson(res, 409, { ok: false, error: 'Уже выполняется другой запрос этого аккаунта.' });
          const plan = planOf(u);
          const wanted = body.model && MODELS[body.model] ? body.model : modelOf(u).key;
          const model = modelAvailableTo(u, MODELS[wanted]) ? MODELS[wanted] : modelOf(u);
          const usingOffer = offerActiveFor(u, model.key);
          if (!model.unlimited && !usingOffer) {
            const { blocked } = checkLimits(u, model.provider);
            if (blocked) return sendJson(res, 429, { ok: false, error: 'Лимит тарифа исчерпан — смотрите /usage в боте.' });
          }

          // У приложения свой чат, отдельный от бота и сайта
          let chat = body.chatId ? store.getChat(u, body.chatId) : null;
          if (!chat) chat = store.newChat(u, 'Clop Code (ПК)');
          const chatBefore = { length: chat.messages.length, title: chat.title, updatedAt: chat.updatedAt };
          store.pushMessage(chat, 'user', prompt);

          const allowed = allowedEffortOptions(u, model);
          const effortKey = body.effort && allowed.includes(body.effort) ? body.effort : effortOf(u, model).key;
          const images = stashImages(body.images);
          const office = officePrefix(body.office);
          if (office) prompt = office + prompt;

          // Поток включается по просьбе клиента: старые версии приложения
          // ждут обычный ответ одним куском, и ломать их незачем
          const wantStream = body.stream === true;
          let clientGone = false;
          const requestAbort = new AbortController();
          res.once('close', () => {
            if (!res.writableEnded) {
              clientGone = true;
              requestAbort.abort();
            }
          });
          let sendDelta = null;
          if (wantStream) {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-transform',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            });
            let streamed = '';
            sendDelta = (piece) => {
              const snapshot = String(piece || '');
              if (!snapshot) return;
              const delta = snapshot.startsWith(streamed) ? snapshot.slice(streamed.length) : snapshot;
              streamed = snapshot;
              if (!delta) return;
              try { res.write(`data: ${JSON.stringify({ delta })}\n\n`); } catch { clientGone = true; }
            };
          }
          const finish = (payload) => {
            if (!wantStream) return sendJson(res, payload.ok ? 200 : (payload.status || 500), payload);
            try {
              res.write(`data: ${JSON.stringify({ done: true, ...payload })}\n\n`);
              res.end();
            } catch { /* соединение уже закрыто */ }
          };
          desktopBusy.add(busyKey);
          try {
            // Один выбор действует в боте, на сайте и в Clop Code.
            u.model = model.key;
            u.effort = effortKey;
            if (typeof body.fast === 'boolean') u.fast = body.fast;
            const fast = model.provider === 'gpt' && u.fast === true;
            const r = await askModelImpl({ chat, model, effortKey, prompt, images, onDelta: sendDelta, fast, signal: requestAbort.signal, client: 'desktop' });
            if (clientGone) {
              chat.messages.splice(chatBefore.length);
              chat.title = chatBefore.title;
              chat.updatedAt = chatBefore.updatedAt;
              await store.save();
              return;
            }
            if (!r.ok) return finish({ ok: false, error: r.error, status: 502 });
            if (r.runtime === 'gpt') chat.gptThreadId = r.threadId; else chat.sessionId = r.sessionId;
            // Модель создаёт файлы через безопасные текстовые маркеры. В
            // истории сохраняем полный ответ для продолжения контекста, а
            // приложению отдаём чистый текст и отдельные base64-вложения.
            const extracted = extractFiles(r.text);
            const outputFiles = filesForJson(extracted.files);
            const displayText = (extracted.files.length || extracted.truncated)
              ? (extracted.cleanText || (extracted.truncated
                ? `Файл «${extracted.truncated}» не был завершён моделью. Попросите продолжить.`
                : `Готово — создано файлов: ${extracted.files.length}.`))
              : r.text;
            // Ответ desktop-агенту должен содержать действие, если клиент
            // явно запросил работу в папке или полный доступ. Пустая отписка
            // возвращается приложению для автоматического повтора, но квоту
            // пользователя не расходует.
            const expectsAction = /<clop_protocol_reminder\b/i.test(prompt)
              || (/<clop_protocol>/i.test(prompt) && /(?:Access mode:\s*|\bmode=)(?:workspace|full)\b/i.test(prompt));
            const issuedAction = /<clop_action>\s*\{[\s\S]*?\}\s*<\/clop_action>/i.test(r.text);
            const chargeResponse = !expectsAction || issuedAction;
            if (chargeResponse) {
              store.pushMessage(chat, 'assistant', r.text, { tokens: r.tokens.total, model: model.key, effort: effortKey });
            }
            const measuredBillable = Number.isFinite(r.tokens.billable)
              ? r.tokens.billable
              : (Number(r.tokens.input || 0) + Number(r.tokens.output || 0) || Number(r.tokens.total || 0));
            const billableForLimit = chargeResponse
              ? Math.round(measuredBillable * (model.limitMultiplier ?? 1) * (fast ? 1.2 : 1))
              : 0;
            if (!model.unlimited && chargeResponse) {
              const offerBonus = addOfferUsage(u, model.key, measuredBillable);
              store.addUsage(u, {
                ts: Date.now(), chatId: chat.id, model: model.key, effort: effortKey, plan: plan.key,
                input: r.tokens.input, output: r.tokens.output,
                cacheWrite: r.tokens.cacheWrite, cacheRead: r.tokens.cacheRead,
                promptTokens: r.tokens.promptTokens,
                total: r.tokens.total,
                billable: billableForLimit,
                billingVersion: BILLING_VERSION, offerBonus,
                costUsd: r.costUsd, durationMs: r.durationMs, source: 'desktop',
              });
            }
            await store.save();
            // Приложение показывает расход и время генерации по каждому шагу
            return finish({
              ok: true, text: displayText, files: outputFiles,
              output_files: outputFiles, truncatedFile: extracted.truncated,
              chatId: chat.id, model: model.key,
              tokens: {
                input: r.tokens.promptTokens || 0,
                output: r.tokens.output || 0,
                total: billableForLimit,
                billable: billableForLimit,
              },
              quotaCharged: chargeResponse,
              durationMs: r.durationMs,
            });
          } catch (e) {
            return finish({ ok: false, error: String(e.message || e).slice(0, 300) });
          } finally {
            if (images) { vision.drop(images.dir); vision.sweep(); }
            desktopBusy.delete(busyKey);
          }
        }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
        return;
      }

      sendJson(res, 404, { ok: false, error: 'неизвестный метод' });
      return;
    }
    // Изданные сайты. Отдаём под sandbox: это чужой HTML на нашем домене,
    // и без песочницы он мог бы прочитать куки чата или дёрнуть /chat/api
    // от имени заглянувшего. В песочнице у страницы своё происхождение —
    // свои скрипты работают, до нашего сайта дотянуться нельзя.
    if (url.pathname === '/s' || url.pathname.startsWith('/s/')) {
      const rest = url.pathname.slice(3);
      const slash = rest.indexOf('/');
      const slug = slash < 0 ? rest : rest.slice(0, slash);
      const inner = slash < 0 ? '' : rest.slice(slash + 1);
      if (!/^[a-z0-9]{4,12}$/i.test(slug)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end('Сайт не найден'); }
      // Точку входа отдаём только по адресу со слэшем на конце: иначе
      // браузер считает последний сегмент именем файла и ищет style.css
      // в /s/, а не внутри сайта — страница приходит без стилей.
      if (slash < 0) {
        res.writeHead(302, { location: `/s/${slug}/${url.search || ''}` });
        return void res.end();
      }
      sites.getFile(slug, inner).then((file) => {
        if (!file) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Сайт не найден'); }
        res.writeHead(200, {
          'content-type': file.type,
          'content-security-policy': "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'cache-control': 'public, max-age=60',
        });
        res.end(file.content);
      }).catch(() => { res.writeHead(500); res.end(); });
      return;
    }

    // Стили рабочего интерфейса подключаются публичной страницей /chat и
    // поэтому тоже должны быть доступны до Basic Auth панели. Раздаём только
    // один заранее известный файл, с защитой от MIME-sniffing и коротким кэшем.
    if (url.pathname === '/workspace.css' && (req.method === 'GET' || req.method === 'HEAD')) {
      const full = path.join(PUBLIC, 'workspace.css');
      if (!fs.existsSync(full)) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cache-control': 'public, max-age=3600',
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(full).pipe(res);
    }

    if (url.pathname === '/download' && (req.method === 'GET' || req.method === 'HEAD')) {
      return serveDesktopFile(req, res, 'download.html');
    }
    if (url.pathname.startsWith('/downloads/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const name = url.pathname.slice('/downloads/'.length);
      if (!DESKTOP_DOWNLOADS.has(name)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('404');
      }
      return serveDesktopFile(req, res, name, { download: true });
    }

    if (PWA_FILES[url.pathname]) {
      const full = path.join(PUBLIC, url.pathname.slice(1));
      if (!fs.existsSync(full)) { res.writeHead(404); return res.end('404'); }
      const head = { 'content-type': PWA_FILES[url.pathname] };
      // Область действия service worker должна охватывать весь сайт
      if (url.pathname === '/sw.js') { head['service-worker-allowed'] = '/'; head['cache-control'] = 'no-cache'; }
      res.writeHead(200, head);
      return fs.createReadStream(full).pipe(res);
    }

    // Шаг 1: сайт просит код → отдаём код и диплинк на бота
    if (url.pathname === '/chat/api/login/start' && req.method === 'POST') {
      const code = createCode();
      return sendJson(res, 200, { code, tgLink: `https://t.me/${getBotUsername()}?start=weblogin_${code}` });
    }
    // Шаг 2: сайт поллит — бот уже привязал код к аккаунту?
    if (url.pathname === '/chat/api/login/status' && req.method === 'GET') {
      const code = url.searchParams.get('code') || '';
      const userId = peekClaimed(code);
      return sendJson(res, 200, { claimed: Boolean(userId) });
    }
    // Шаг 3: сайт меняет одноразовый код на сессионную cookie
    if (url.pathname === '/chat/api/login/exchange' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        const userId = consumeCode(String(body.code || ''));
        if (!userId) return sendJson(res, 400, { ok: false, error: 'code not claimed or expired' });
        if (reloadEachRequest) await store.load();
        if (!store.findUser(userId)) return sendJson(res, 404, { ok: false, error: 'user not found' });
        setSessionCookie(res, userId);
        return sendJson(res, 200, { ok: true });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    // Созданные моделью файлы лежат отдельными временными ключами, а ссылка
    // работает только для владельца текущей подписанной web-сессии.
    if (url.pathname === '/chat/api/artifact') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET, HEAD' });
      }
      (async () => {
        if (reloadEachRequest) await store.load();
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        const artifact = await chatArtifacts.getArtifact(u.id, url.searchParams.get('id'));
        if (!artifact) return sendJson(res, 404, { ok: false, error: 'artifact not found or expired' });
        const content = Buffer.from(artifact.content, 'utf8');
        res.writeHead(200, {
          'content-type': artifact.mimeType,
          'content-length': content.length,
          'content-disposition': attachmentDisposition(artifact.name),
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        });
        if (req.method === 'HEAD') return res.end();
        return res.end(content);
      })().catch((error) => sendJson(res, 500, { ok: false, error: String(error.message || error).slice(0, 300) }));
      return;
    }

    // Берём чат сайта по id (валидируем, что он принадлежит этому пользователю
    // и жив), иначе — последний живой чат, иначе — создаём новый
    function resolveChat(u, chatId) {
      let c = chatId ? store.getChat(u, chatId) : null;
      if (c && c.deleted) c = null;
      if (!c) c = store.liveChats(u)[0] || store.newChat(u, 'Чат с сайта');
      return c;
    }
    function chatSummary(u, c) {
      return { id: c.id, title: c.title, model: availableModelOf(u, c.model).key, messagesCount: c.messages.length, updatedAt: c.updatedAt };
    }

    // Данные для инициализации UI: тариф, модели с доступностью, список чатов
    if (url.pathname === '/chat/api/me' && req.method === 'GET') {
      (reloadEachRequest ? store.load() : Promise.resolve()).then(() => {
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        const plan = planOf(u);
        const chat = resolveChat(u, url.searchParams.get('chatId'));
        const model = availableModelOf(u, chat.model);
        const models = Object.values(MODELS).map((m) => ({
          key: m.key, title: m.title, provider: m.provider,
          description: m.desc || '',
          recommended: m.recommended === true,
          heavy: m.heavy === true,
          heavyNote: m.heavyNote || '',
          limitMultiplier: m.limitMultiplier || 1,
          plans: modelPlans(m),
          available: modelAvailableTo(u, m),
          supportsEffort: m.supportsEffort !== false,
        }));
        // Доступные уровни силы мышления по каждой модели — с учётом тарифа
        // (locked/fixed/xhigh и т.п.), чтобы сайт не предлагал то, чего нет в боте
        const effortOptionsByModel = Object.fromEntries(
          Object.values(MODELS).map((m) => [m.key, allowedEffortOptions(u, m)])
        );
        return sendJson(res, 200, {
          ok: true,
          name: store.displayName(u),
          plan: plan.key,
          planTitle: plan.title,
          currentChatId: chat.id,
          currentModel: model.key,
          effort: effortOf(u, model).key,
          fast: u.fast === true,
          effortOptionsByModel,
          limits: publicLimits(u),
          modelPromo: modelPromoActive()
            ? { title: MODEL_PROMO.title, until: MODEL_PROMO.until, models: MODEL_PROMO.models }
            : null,
          limitedOffer: offerState(u),
          bonuses: store.bonusReport(u),
          models,
          chats: store.liveChats(u).map((item) => chatSummary(u, item)),
          messages: chat.messages.map(publicChatMessage),
        });
      });
      return;
    }
    if (url.pathname === '/chat/api/bugs' && req.method === 'GET') {
      (reloadEachRequest ? store.load() : Promise.resolve()).then(() => {
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        return sendJson(res, 200, {
          ok: true,
          bugs: support.userTickets(u.id).filter((ticket) => ticket.type === 'bug').map(publicBug),
          bonuses: store.bonusReport(u),
        });
      }).catch(() => sendJson(res, 500, { ok: false }));
      return;
    }

    if (url.pathname === '/chat/api/bugs' && req.method === 'POST') {
      readJsonBody(req, 20_000).then(async (body) => {
        if (reloadEachRequest) await store.load();
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        const ticket = support.createBugReport(u, body.description, String(body.platform || 'Сайт'));
        await store.save({ strict: true });
        for (const adminId of ADMIN_IDS) notifyUser(adminId, `🐞 Новый баг №${ticket.id} от ${store.displayName(u)}${u.username ? ` (@${u.username})` : ''}\n\n${ticket.messages[0].text.slice(0, 900)}`);
        return sendJson(res, 201, { ok: true, bug: publicBug(ticket) });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    // Список чатов (для обновления сайдбара без полного /me)
    if (url.pathname === '/chat/api/chats' && req.method === 'GET') {
      (reloadEachRequest ? store.load() : Promise.resolve()).then(() => {
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        return sendJson(res, 200, { ok: true, chats: store.liveChats(u).map((item) => chatSummary(u, item)) });
      });
      return;
    }
    // Новый чат
    if (url.pathname === '/chat/api/chats/new' && req.method === 'POST') {
      (reloadEachRequest ? store.load() : Promise.resolve()).then(async () => {
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        const c = store.newChat(u, 'Чат с сайта');
        await store.save();
        return sendJson(res, 200, { ok: true, chat: chatSummary(u, c) });
      });
      return;
    }
    // Удалить чат (мягко — как в боте)
    if (url.pathname === '/chat/api/chats/delete' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        if (reloadEachRequest) await store.load();
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        store.deleteChat(u, String(body.chatId || ''));
        await store.save();
        return sendJson(res, 200, { ok: true });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }
    // Сообщения конкретного чата (для переключения между чатами в сайдбаре)
    if (url.pathname === '/chat/api/chat' && req.method === 'GET') {
      (reloadEachRequest ? store.load() : Promise.resolve()).then(() => {
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        const chat = store.getChat(u, url.searchParams.get('id'));
        if (!chat || chat.deleted) return sendJson(res, 404, { ok: false, error: 'chat not found' });
        const model = availableModelOf(u, chat.model);
        return sendJson(res, 200, {
          ok: true, id: chat.id, model: model.key,
          effort: effortOf(u, model).key,
          fast: u.fast === true,
          messages: chat.messages.map(publicChatMessage),
        });
      });
      return;
    }
    // --- Профиль: аккаунт, лимиты и настройки по умолчанию ---
    // Модель и сила мышления живут в тех же полях, что использует бот
    // (u.model / u.effort) — меняешь на сайте, меняется и в Telegram.

    if (url.pathname === '/chat/api/profile' && req.method === 'GET') {
      (reloadEachRequest ? store.load() : Promise.resolve()).then(() => {
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        const plan = planOf(u);
        const model = modelOf(u);
        const img = imageLimitState(u);
        return sendJson(res, 200, {
          ok: true,
          name: store.displayName(u),
          username: u.username ? '@' + u.username : '',
          plan: plan.key,
          planTitle: plan.title,
          planEmoji: plan.emoji,
          proUntil: u.proUntil || 0,
          createdAt: u.createdAt,
          stats: u.stats,
          model: model.key,
          effort: effortOf(u, model).key,
          fast: u.fast === true,
          effortOptions: allowedEffortOptions(u, model),
          models: Object.values(MODELS).map((m) => ({
            key: m.key, title: m.title, provider: m.provider,
            available: modelAvailableTo(u, m),
            limitMultiplier: m.limitMultiplier || 1,
            supportsEffort: m.supportsEffort !== false,
          })),
          effortOptionsByModel: Object.fromEntries(
            Object.values(MODELS).map((m) => [m.key, allowedEffortOptions(u, m)])
          ),
          limits: publicLimits(u),
          images: { used: img.used, limit: img.limit, left: img.left },
          chatsCount: store.liveChats(u).length,
          limitedOffer: offerState(u),
          bonuses: store.bonusReport(u),
        });
      });
      return;
    }

    // Сохранить настройки по умолчанию (модель / сила мышления)
    if (url.pathname === '/chat/api/profile' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        if (reloadEachRequest) await store.load();
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        const plan = planOf(u);

        if (body.model) {
          const m = MODELS[String(body.model)];
          if (!m) return sendJson(res, 400, { ok: false, error: 'Неизвестная модель.' });
          if (!modelAvailableTo(u, m)) {
            return sendJson(res, 403, { ok: false, error: `${m.title} недоступна на тарифе ${plan.title}.` });
          }
          u.model = m.key;
        }
        if (body.effort) {
          const m = MODELS[u.model] || modelOf(u);
          if (!allowedEffortOptions(u, m).includes(String(body.effort))) {
            return sendJson(res, 403, { ok: false, error: 'Эта сила мышления недоступна на вашем тарифе.' });
          }
          u.effort = String(body.effort);
        }
        if (typeof body.fast === 'boolean') u.fast = body.fast;
        await store.save();
        const m = modelOf(u);
        return sendJson(res, 200, { ok: true, model: m.key, effort: effortOf(u, m).key, fast: u.fast === true });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    if (url.pathname === '/chat/api/offer/claim' && req.method === 'POST') {
      (reloadEachRequest ? store.load() : Promise.resolve()).then(async () => {
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        const offer = claimOffer(u);
        if (!offer) return sendJson(res, 410, { ok: false, error: 'Предложение завершилось.' });
        await store.save({ strict: true });
        return sendJson(res, 200, { ok: true, limitedOffer: offer });
      }).catch((e) => sendJson(res, 500, { ok: false, error: String(e.message || e) }));
      return;
    }

    // Тарифы для сайта: кнопка «Купить» ведёт в бота диплинком, счёт в
    // звёздах выставляет уже сам Telegram — на сайте оплаты нет.
    if (url.pathname === '/chat/api/plans' && req.method === 'GET') {
      (reloadEachRequest ? store.load() : Promise.resolve()).then(() => {
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        const cur = planOf(u);
        return sendJson(res, 200, {
          ok: true,
          current: cur.corporateKey || cur.key,
          proUntil: store.activeTeamFor(u)?.until || u.proUntil || 0,
          // Акция отдаётся сайту отдельным полем: он покажет баннер и не
          // будет предлагать купить то, что сейчас и так открыто всем
          promo: freeGoActive() ? { plan: FREE_GO_PLAN, until: FREE_GO_UNTIL } : null,
          bot: getBotUsername(),
          // Конкретные лимиты в токенах наружу не отдаём — на сайте они не
          // показываются, и светить их в ответе API незачем
          plans: [...Object.values(PLANS), ...(corporatePlansReady() ? Object.values(CORPORATE_PLANS) : [])].map((p) => ({
            key: p.key, title: p.title, stars: p.stars, days: p.days, perks: p.perks,
          })),
        });
      });
      return;
    }

    // Удалить все чаты (мягко — как в боте, остаются только в админ-панели)
    if (url.pathname === '/chat/api/chats/clear' && req.method === 'POST') {
      (reloadEachRequest ? store.load() : Promise.resolve()).then(async () => {
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        let n = 0;
        for (const c of store.liveChats(u)) { store.deleteChat(u, c.id); n++; }
        await store.save();
        return sendJson(res, 200, { ok: true, deleted: n });
      });
      return;
    }

    // --- «Мой API» на сайте: до 5 ключей + песочница для отладки запросов ---

    // Достаём пользователя сессии; null, если не залогинен
    async function sessionUser(req) {
      if (reloadEachRequest) await store.load();
      const userId = sessionUserId(req);
      return (userId && store.findUser(userId)) || null;
    }

    if (url.pathname === '/chat/api/keys' && req.method === 'GET') {
      (async () => {
        const u = await sessionUser(req);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        if (!cloudEnabled()) return sendJson(res, 503, { ok: false, error: 'Облачный API сейчас недоступен.' });
        const r = await listApiKeys(u.id, planOf(u).key);
        if (!r) return sendJson(res, 502, { ok: false, error: 'Облачный сервис не ответил — попробуйте ещё раз.' });
        // Помечаем, что у пользователя есть ключ: по этому флагу бот раз в
        // 4 минуты обновляет облаку его тариф. Без пометки (ключ выдан только
        // на сайте) тариф там протухал и откатывался на free.
        if ((r.keys || []).length && !u.cloudKey) { u.cloudKey = true; await store.save(); }
        return sendJson(res, 200, { ok: true, keys: r.keys || [], max: r.max || 5, baseUrl: process.env.CLOUD_API_URL || '', bot: getBotUsername(), billing: { balanceUsd: microsToUsd(u.balanceMicros), starsPerUsd: STARS_PER_USD, minStars: MIN_TOPUP_STARS, maxStars: MAX_TOPUP_STARS, prices: API_PRICES } });
      })().catch((e) => sendJson(res, 500, { ok: false, error: String(e.message || e) }));
      return;
    }

    if (url.pathname === '/chat/api/keys/create' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        const u = await sessionUser(req);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        if (!cloudEnabled()) return sendJson(res, 503, { ok: false, error: 'Облачный API сейчас недоступен.' });
        const mode = body.mode === 'payg' ? 'payg' : 'subscription';
        if (mode === 'payg' && Number(u.balanceMicros || 0) <= 0) return sendJson(res, 402, { ok: false, error: 'Сначала пополните баланс минимум на $1.' });
        const r = await createApiKey(u.id, planOf(u).key, String(body.label || ''), mode);
        if (!r) return sendJson(res, 502, { ok: false, error: 'Не удалось создать ключ — облако не ответило.' });
        if (r.error) return sendJson(res, 400, { ok: false, error: `Достигнут лимит: максимум ${r.max || 5} ключей.` });
        u.cloudKey = true; // чтобы бот периодически освежал тариф в облаке
        await store.save();
        return sendJson(res, 200, { ok: true, key: r.apiKey });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    if (url.pathname === '/chat/api/keys/delete' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        const u = await sessionUser(req);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        if (!cloudEnabled()) return sendJson(res, 503, { ok: false, error: 'Облачный API сейчас недоступен.' });
        const r = await deleteApiKey(u.id, String(body.key || ''));
        if (!r) return sendJson(res, 502, { ok: false, error: 'Не удалось удалить ключ — облако не ответило.' });
        return sendJson(res, 200, { ok: true });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    // Песочница: шлём тестовый запрос в облако от имени пользователя и
    // возвращаем сырой ответ (статус/тело/время) — чтобы можно было отлаживать
    if (url.pathname === '/chat/api/keys/test' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        const u = await sessionUser(req);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        if (!cloudEnabled()) return sendJson(res, 503, { ok: false, error: 'Облачный API сейчас недоступен.' });

        const apiKey = String(body.apiKey || '');
        // Проксируем только ключами самого пользователя — иначе наш сервер
        // стал бы открытым релеем для чужих/подобранных ключей
        const mine = await listApiKeys(u.id, planOf(u).key);
        if (!mine || !(mine.keys || []).some((k) => k.key === apiKey)) {
          return sendJson(res, 403, { ok: false, error: 'Этот ключ не принадлежит вашему аккаунту.' });
        }

        const allowedPaths = new Set(['/v1/files', '/v1/ask', '/v1/chat/completions', '/v1/messages']);
        const apiPath = String(body.path || '/v1/ask');
        if (!allowedPaths.has(apiPath)) return sendJson(res, 400, { ok: false, error: 'Неизвестный эндпоинт.' });

        const r = await proxyApiRequest({
          path: apiPath, apiKey, body: body.payload || {},
          authHeader: body.authHeader === 'bearer' ? 'bearer' : 'x-api-key',
        });
        if (!r.ok) return sendJson(res, 502, { ok: false, error: r.error, durationMs: r.durationMs });
        return sendJson(res, 200, { ok: true, status: r.status, body: r.body, durationMs: r.durationMs });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    // Конструктор пользовательских Telegram-ботов. Токены шифруются на
    // сервере и никогда не возвращаются браузеру после сохранения.
    if (url.pathname === '/chat/api/bots' && req.method === 'GET') {
      (async () => {
        const u = await sessionUser(req);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        return sendJson(res, 200, {
          ok: true,
          bots: listCustomBots(u.id),
          templates: BOT_TEMPLATES,
          models: Object.entries(API_PRICES).map(([id, price]) => ({ id, ...price })),
          balanceUsd: microsToUsd(u.balanceMicros),
        });
      })().catch((e) => sendJson(res, 500, { ok: false, error: String(e.message || e) }));
      return;
    }

    if (url.pathname === '/chat/api/bots/create' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        const u = await sessionUser(req);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        const mode = body.apiMode === 'own' ? 'own' : body.apiMode === 'payg' ? 'payg' : 'subscription';
        if (mode === 'payg' && Number(u.balanceMicros || 0) <= 0) return sendJson(res, 402, { ok: false, error: 'Для режима по факту сначала пополните баланс минимум на $1.' });
        let managedKey = '';
        try {
          if (mode !== 'own') {
            if (!cloudEnabled()) return sendJson(res, 503, { ok: false, error: 'Облачный API сейчас недоступен.' });
            const created = await createApiKey(u.id, planOf(u).key, `TG-бот ${String(body.title || '').slice(0, 22)}`, mode);
            if (!created?.apiKey) throw new Error(created?.error || 'Не удалось создать ключ API для бота.');
            managedKey = created.apiKey;
            u.cloudKey = true;
          }
          const bot = await createCustomBot({
            ownerId: u.id,
            token: body.token,
            template: body.template,
            title: body.title,
            model: body.model,
            apiMode: mode,
            apiKey: mode === 'own' ? String(body.ownApiKey || '') : managedKey,
            ownBaseUrl: body.ownBaseUrl,
            systemPrompt: body.systemPrompt,
            welcomeText: body.welcomeText,
            pricesText: body.pricesText,
            businessMode: body.businessMode,
          });
          await store.save({ strict: true });
          return sendJson(res, 200, { ok: true, bot });
        } catch (error) {
          if (managedKey) await deleteApiKey(u.id, managedKey).catch(() => null);
          return sendJson(res, 400, { ok: false, error: String(error.message || error) });
        }
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    if (url.pathname === '/chat/api/bots/delete' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        const u = await sessionUser(req);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });
        const removed = await deleteCustomBot(u.id, String(body.id || ''));
        if (!removed) return sendJson(res, 404, { ok: false, error: 'Бот не найден.' });
        if (removed.plainApiKey) await deleteApiKey(u.id, removed.plainApiKey).catch(() => null);
        return sendJson(res, 200, { ok: true });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    // Выйти — просто стираем cookie
    if (url.pathname === '/chat/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', `clop_session=; Max-Age=0; Path=/`);
      return sendJson(res, 200, { ok: true });
    }
    // Собственно сообщение — те же модели, та же сила мышления, тот же лимит,
    // что и в Telegram-боте; текст может включать вставленный файл (клиент сам
    // читает текстовые файлы и добавляет их содержимое в prompt)
    if (url.pathname === '/chat/api/message' && req.method === 'POST') {
      readJsonBody(req, MAX_MESSAGE_BYTES).then(async (body) => {
        if (reloadEachRequest) await store.load();
        const userId = sessionUserId(req);
        const u = userId && store.findUser(userId);
        if (!u) return sendJson(res, 401, { ok: false, error: 'not logged in' });

        const userText = String(body.text || '').trim().slice(0, 60_000);
        if (!userText) return sendJson(res, 400, { ok: false, error: 'text is required' });
        let prompt = userText;

        const plan = planOf(u);
        const requestedKey = body.model && MODELS[body.model] ? body.model : modelOf(u).key;
        const model = availableModelOf(u, requestedKey);

        const usingOffer = offerActiveFor(u, model.key);
        if (!model.unlimited && !usingOffer) {
          const { blocked } = checkLimits(u, model.provider);
          if (blocked) {
            return sendJson(res, 429, {
              ok: false,
              error: `Лимит ${PROVIDERS[model.provider]?.title || model.provider} на ${blocked.title} исчерпан — обновится через ${humanLeft(blocked.resetAt - Date.now())}.`,
            });
          }
        }

        const chat = resolveChat(u, body.chatId);
        chat.model = model.key;

        // Сила мышления — то, что явно выбрал пользователь на сайте, но
        // только если она реально доступна на его тарифе для этой модели
        const allowedEff = allowedEffortOptions(u, model);
        const effortKey = body.effort && allowedEff.includes(body.effort) ? body.effort : effortOf(u, model).key;

        const siteImages = stashImages(body.images);
        try {
          const officeText = officePrefix(body.office);
          if (officeText) prompt = officeText + prompt;
          const fast = model.provider === 'gpt' && u.fast === true;
          // Текущий prompt передаётся отдельным аргументом и появится в истории
          // только после успеха, поэтому transcript не повторяет его дважды.
          const r = await askModelImpl({ chat, model, effortKey, prompt, images: siteImages, fast });
          if (!r.ok) return sendJson(res, 502, { ok: false, error: r.error });
          const tokens = r.tokens || {};

          if (r.runtime === 'gpt') chat.gptThreadId = r.threadId;
          else chat.sessionId = r.sessionId;

          // Если модель завернула несколько файлов в %%%FILE%%% — собираем zip
          // (та же логика, что в боте) и отдаём отдельно от текста ответа
          const { files, cleanText, truncated, truncatedContent } = extractFiles(r.text);
          let zip = null, zipName = null;
          if (files.length) {
            zip = buildZip(files.map((f) => ({ name: f.path, content: f.content }))).toString('base64');
            zipName = `clop-ai-${chat.id}-${Date.now().toString(36)}.zip`;
          }
          // Если в ответе лежит готовый сайт — издаём его и дописываем ссылку
          let siteUrl = null;
          const found = sites.findSite(r.text, files);
          if (found) {
            const pub = await sites.publish(u.id, found);
            if (pub.ok) siteUrl = pub.url;
            else console.warn('[sites]', pub.error);
          }
          let displayText = (files.length || truncated)
            ? (cleanText || (files.length ? `📦 Готово — ${files.length} файл(ов), архив ниже.` : ''))
            : r.text;
          if (truncated) {
            const notice = `⚠️ Файл «${truncated}» не был завершён моделью; частичный текст сохранён в контексте.`;
            displayText = [displayText, notice].filter(Boolean).join('\n\n');
          }
          if (siteUrl) displayText += `

🌐 Сайт опубликован — постоянная ссылка: ${siteUrl}`;
          const artifacts = await chatArtifacts.saveArtifacts(u.id, files);
          store.pushMessage(chat, 'user', userText);
          store.pushMessage(chat, 'assistant', assistantTranscript(displayText, files,
            truncated ? { path: truncated, content: truncatedContent } : null), {
            tokens: tokens.total || 0,
            model: model.key,
            effort: effortKey,
            ...((files.length || truncated) ? { displayText } : {}),
            ...(artifacts.length ? { artifacts } : {}),
          });

          const measuredBillable = Number.isFinite(tokens.billable)
            ? tokens.billable
            : (Number(tokens.input || 0) + Number(tokens.output || 0) || Number(tokens.total || 0));
          const billableForLimit = Math.round(measuredBillable * (model.limitMultiplier ?? 1) * (fast ? 1.2 : 1));
          if (!model.unlimited) {
            const offerBonus = addOfferUsage(u, model.key, measuredBillable);
            store.addUsage(u, {
              ts: Date.now(), chatId: chat.id, model: model.key, effort: effortKey, plan: plan.key,
              input: tokens.input || 0, output: tokens.output || 0,
              cacheWrite: tokens.cacheWrite || 0, cacheRead: tokens.cacheRead || 0,
              promptTokens: tokens.promptTokens || 0,
              total: tokens.total || 0, billable: billableForLimit, costUsd: r.costUsd, durationMs: r.durationMs,
              billingVersion: BILLING_VERSION,
              source: 'site-chat',
              offerBonus,
            });
          }
          await store.save();
          return sendJson(res, 200, {
            ok: true,
            text: displayText,
            model: model.key,
            chatId: chat.id,
            zip,
            zipName,
            artifacts,
            limits: publicLimits(u),
            ...publicUsage(tokens, r.durationMs),
          });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: String(e.message || e).slice(0, 300) });
        } finally {
          if (siteImages) { vision.drop(siteImages.dir); vision.sweep(); }
        }
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    // Панель статистики/чатов — если задан WEB_PASSWORD (публичный деплой,
    // например Render), требуем Basic Auth. Локально (переменная не задана)
    // ведём себя как раньше — без пароля.
    if (WEB_PASSWORD && !checkBasicAuth(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Basic realm="clop-ai"' });
      return res.end('401 Unauthorized');
    }

    /* --- Поддержка: заявки и меры к пользователям ---
       Всё это за паролем панели: ответ оператора, выдача подписки, мут и бан
       меняют чужой доступ, и открывать их наружу нельзя. */
    if (url.pathname === '/api/tickets' && req.method === 'GET') {
      (reloadEachRequest ? store.load() : Promise.resolve()).then(() => {
        const list = support.allTickets().map((t) => {
          const u = store.findUser(t.userId);
          return {
            ...t,
            plan: u ? planOf(u).title : '—',
            banned: u ? support.isBanned(u) : false,
            muted: u ? support.isMuted(u) : false,
            until: u && (u.ban || u.mute) ? (u.ban?.until || u.mute?.until || 0) : 0,
          };
        });
        return sendJson(res, 200, {
          ok: true,
          tickets: list,
          plans: Object.values(PLANS).map((p) => ({ key: p.key, title: p.title, days: p.days })),
          bugRewards: Object.values(support.BUG_REWARDS),
        });
      });
      return;
    }

    if (url.pathname === '/api/ticket/reply' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        if (reloadEachRequest) await store.load();
        const t = support.findTicket(body.id);
        if (!t) return sendJson(res, 404, { ok: false, error: 'заявка не найдена' });
        const text = String(body.text || '').trim();
        if (!text) return sendJson(res, 400, { ok: false, error: 'пустой ответ' });
        support.addMessage(t, 'admin', text);
        await store.save();
        // Ответ уходит человеку сразу в бота — ради этого заявка и заводилась
        notifyUser(t.userId, `📨 *Ответ по заявке №${t.id}*\n\n${text}`);
        return sendJson(res, 200, { ok: true, ticket: t });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    if (url.pathname === '/api/ticket/close' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        if (reloadEachRequest) await store.load();
        const t = support.findTicket(body.id);
        if (!t) return sendJson(res, 404, { ok: false, error: 'заявка не найдена' });
        support.closeTicket(t);
        await store.save();
        notifyUser(t.userId, `✅ Заявка №${t.id} закрыта. Если вопрос остался — напишите в /support.`);
        return sendJson(res, 200, { ok: true });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    if (url.pathname === '/api/ticket/decision' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        if (reloadEachRequest) await store.load();
        const ticket = support.findTicket(body.id);
        if (!ticket) return sendJson(res, 404, { ok: false, error: 'баг не найден' });
        const user = store.findUser(ticket.userId);
        if (!user) return sendJson(res, 404, { ok: false, error: 'пользователь не найден' });
        const decision = String(body.decision || '');
        const reward = decision === 'accepted' ? support.BUG_REWARDS[String(body.reward || '')] : null;
        support.decideBug(ticket, decision, reward);
        if (decision === 'accepted' && reward.type === 'limit-reset') {
          store.resetFiveHourUsage(user, { reason: `Вознаграждение за баг №${ticket.id}`, sourceId: `bug:${ticket.id}` });
        } else if (decision === 'accepted' && reward.type === 'bonus') {
          store.addBonus(user, reward.amount, { reason: `Вознаграждение за баг №${ticket.id}`, sourceId: `bug:${ticket.id}` });
        }
        await store.save({ strict: true });
        notifyUser(user.id, decision === 'accepted'
          ? `✅ Баг №${ticket.id} принят. Вознаграждение: *${reward.label}*.${reward.type === 'bonus' ? ` Баланс: *${store.bonusBalance(user)} бонусов*.` : ''}`
          : `❌ Баг №${ticket.id} отклонён. Спасибо, что сообщили — описание сохранено для анализа.`);
        return sendJson(res, 200, { ok: true, ticket, bonuses: store.bonusReport(user) });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    if (url.pathname === '/api/user/grant' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        if (reloadEachRequest) await store.load();
        const u = store.findUser(body.userId);
        if (!u) return sendJson(res, 404, { ok: false, error: 'пользователь не найден' });
        const plan = PLANS[String(body.plan || '')];
        if (!plan || plan.key === 'free') return sendJson(res, 400, { ok: false, error: 'неизвестный тариф' });
        const days = Math.min(400, Math.max(1, Number(body.days) || plan.days));
        store.grantPlan(u, plan.key, days, { manual: true, by: 'панель' });
        await store.save();
        notifyUser(u.id, `🎁 Вам выдан тариф *${plan.title}* на ${days} дн. Приятной работы!`);
        return sendJson(res, 200, { ok: true, plan: plan.title, days });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    if (url.pathname === '/api/user/refund-usage' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        if (reloadEachRequest) await store.load();
        const u = store.findUser(String(body.userId || ''));
        if (!u) return sendJson(res, 404, { ok: false, error: 'пользователь не найден' });
        const from = Number(body.from);
        const to = Number(body.to);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 2 * 60 * 60 * 1000) {
          return sendJson(res, 400, { ok: false, error: 'некорректный период возврата' });
        }
        const removed = [];
        u.usage = (u.usage || []).filter((event) => {
          const match = event.source === 'desktop' && event.ts >= from && event.ts <= to;
          if (match) removed.push(event);
          return !match;
        });
        const rawTokens = removed.reduce((sum, event) => sum + Math.max(0, Number(event.total || 0)), 0);
        const refunded = removed.reduce((sum, event) => sum + Math.max(0, Number(event.billable || event.total || 0)), 0);
        if (u.stats) {
          u.stats.requests = Math.max(0, Number(u.stats.requests || 0) - removed.length);
          u.stats.tokens = Math.max(0, Number(u.stats.tokens || 0) - rawTokens);
        }
        await store.save({ strict: true });
        return sendJson(res, 200, { ok: true, removed: removed.length, refunded });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    /* Перенос аккаунта: всё нажитое переезжает на другой Telegram-аккаунт.
       Оба конца ищем и по числовому id, и по имени со собачкой — в панели
       перед глазами имя, а ключ у бота числовой. */
    if (url.pathname === '/api/user/transfer' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        if (reloadEachRequest) await store.load();
        const найти = (v) => {
          const s = String(v || '').trim();
          if (!s) return null;
          return store.findUser(s.replace(/^@/, '')) || store.findUserByUsername(s);
        };
        const from = найти(body.from);
        const to = найти(body.to);
        if (!from) return sendJson(res, 404, { ok: false, error: 'аккаунт-источник не найден' });
        if (!to) return sendJson(res, 404, { ok: false, error: 'принимающий аккаунт не найден — пусть он сначала напишет боту' });
        if (from.id === to.id) return sendJson(res, 400, { ok: false, error: 'это один и тот же аккаунт' });

        const итог = store.transferAccount(from, to);
        await store.save();
        console.log(`[перенос] ${store.displayName(from)} -> ${store.displayName(to)}: ${JSON.stringify(итог)}`);
        return sendJson(res, 200, {
          ok: true,
          from: { id: from.id, name: store.displayName(from) },
          to: { id: to.id, name: store.displayName(to) },
          ...итог,
        });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    if (url.pathname === '/api/user/restrict' && req.method === 'POST') {
      readJsonBody(req).then(async (body) => {
        if (reloadEachRequest) await store.load();
        const u = store.findUser(body.userId);
        if (!u) return sendJson(res, 404, { ok: false, error: 'пользователь не найден' });
        const kind = body.kind === 'ban' ? 'ban' : 'mute';
        if (body.release) {
          support.release(u, kind);
          await store.save();
          notifyUser(u.id, kind === 'ban' ? '✅ Доступ к сервису восстановлен.' : '✅ Ограничение на модели снято.');
          return sendJson(res, 200, { ok: true, released: true });
        }
        const minutes = Math.min(60 * 24 * 365, Math.max(1, Number(body.minutes) || 60));
        support.restrict(u, kind, minutes, body.reason);
        await store.save();
        notifyUser(u.id, support.restrictionNote(u));
        return sendJson(res, 200, { ok: true, minutes });
      }).catch((e) => sendJson(res, 400, { ok: false, error: String(e.message || e) }));
      return;
    }

    if (url.pathname === '/api/stats') {
      (reloadEachRequest ? store.load() : Promise.resolve()).then(() => {
        const body = JSON.stringify(buildStats());
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      });
      return;
    }
    if (url.pathname === '/api/user') {
      (reloadEachRequest ? store.load() : Promise.resolve()).then(() => {
        const id = url.searchParams.get('id');
        const detail = id ? buildUserDetail(id) : null;
        res.writeHead(detail ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(detail || { error: 'not found' }));
      });
      return;
    }
    const file = url.pathname === '/'
      ? 'index.html'
      : (url.pathname === '/download' ? 'download.html' : url.pathname.replace(/^\/+/, ''));
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    const type = full.endsWith('.html') ? 'text/html; charset=utf-8'
      : full.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : full.endsWith('.css') ? 'text/css; charset=utf-8'
      : full.endsWith('.png') ? 'image/png'
      : full.endsWith('.webmanifest') ? 'application/manifest+json; charset=utf-8'
      : 'application/octet-stream';
    // Service worker обязан отдаваться с корня, иначе его область (scope)
    // окажется уже нужной и установка приложения не сработает
    const isDownload = file.startsWith('downloads/');
    const stat = fs.statSync(full);
    const extra = full.endsWith('sw.js')
      ? { 'service-worker-allowed': '/', 'cache-control': 'no-cache' }
      : (isDownload ? {
        'content-disposition': `attachment; filename="${path.basename(full).replaceAll('"', '')}"`,
        'cache-control': 'public, max-age=31536000, immutable',
        'accept-ranges': 'bytes',
      } : {});
    const range = isDownload && req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        ...extra,
      });
      return fs.createReadStream(full, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, ...extra });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
  server.listen(WEB_PORT, WEB_HOST, () => {
    console.log(`[web] панель: http://${WEB_HOST}:${WEB_PORT}`);
  });
  return server;
}
