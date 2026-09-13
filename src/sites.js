import crypto from 'node:crypto';
import { redisClient } from './store.js';
import { PUBLIC_URL } from './config.js';
import { hostingQuota, hostingUsage } from './hosting.js';

/* Публикация сайтов, которые собрал ИИ.

   Ответ модели с сайтом приходит либо набором файлов в маркерах %%%FILE%%%,
   либо одним блоком кода с целым HTML-документом. И то и другое кладём в
   Redis и отдаём по постоянной ссылке /s/<код>. Диск Render сбрасывается на
   каждом деплое, Redis — нет, поэтому ссылка живёт, пока её не удалят.

   Важно про безопасность: это чужой HTML на том же домене, что админ-панель
   и чат. Поэтому страницы отдаются с заголовком `Content-Security-Policy:
   sandbox` — браузер кладёт их в отдельное происхождение, и такая страница
   не может ни прочитать куки сайта, ни дёрнуть /chat/api от имени
   заглянувшего. Скрипты внутри самой страницы при этом работают. */

const KEY = (slug) => `clop:site:${slug}`;
const IDX = (uid) => `clop:usites:${uid}`;

// Без Redis (локальный запуск) сайты живут в памяти процесса
const mem = new Map();
const memIdx = new Map();
const userMutations = new Map();

export const MAX_SITE_BYTES = 64 * 1024 * 1024;
export const FREE_SITES_PER_USER = 3;
export const PAID_SITES_PER_USER = 10;
export const MAX_SITES_PER_USER = PAID_SITES_PER_USER;

export function siteLimit(planKey) {
  return String(planKey || 'free') === 'free' ? FREE_SITES_PER_USER : PAID_SITES_PER_USER;
}

export async function storageUsed(userId) {
  const list = await listSites(userId);
  return list.reduce((total, site) => total + Math.max(0, Number(site.bytes || 0)), 0);
}

export async function hostingState(userId, planKey = 'free') {
  return hostingUsage(await storageUsed(userId), planKey);
}

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8', txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};
export const typeOf = (path) => TYPES[String(path).split('.').pop().toLowerCase()] || 'text/plain; charset=utf-8';

const slugId = () => crypto.randomBytes(6).toString('hex');

function serializeUserMutation(userId, task) {
  const key = String(userId);
  const previous = userMutations.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  userMutations.set(key, current);
  return current.finally(() => {
    if (userMutations.get(key) === current) userMutations.delete(key);
  });
}

// Пути приходят от модели, поэтому нормализуем жёстко: никаких выходов вверх,
// абсолютных путей и обратных слэшей
function safePath(p) {
  const s = String(p).replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!s || s.length > 180) return null;
  if (s.split('/').some((part) => part === '..' || part === '.' || !part)) return null;
  return s;
}

async function readSite(slug) {
  const r = redisClient();
  if (!r) return mem.get(slug) || null;
  try { return (await r.get(KEY(slug))) || null; } catch (e) {
    console.error('[sites] чтение не удалось', e.message);
    throw e;
  }
}

async function writeSite(slug, site) {
  const r = redisClient();
  if (!r) { mem.set(slug, site); return true; }
  try { await r.set(KEY(slug), site); return true; } catch (e) {
    console.error('[sites] запись не удалась', e.message);
    throw e;
  }
}

async function deleteSite(slug) {
  const r = redisClient();
  if (!r) { mem.delete(slug); return; }
  await r.del(KEY(slug));
}

async function readIndex(uid) {
  const r = redisClient();
  if (!r) return memIdx.get(String(uid)) || [];
  try { return (await r.get(IDX(uid))) || []; } catch (e) {
    console.error('[sites] чтение индекса не удалось', e.message);
    throw e;
  }
}

async function writeIndex(uid, list) {
  const r = redisClient();
  if (!r) { memIdx.set(String(uid), list); return; }
  try { await r.set(IDX(uid), list); } catch (e) {
    console.error('[sites] запись индекса не удалась', e.message);
    throw e;
  }
}

/* Ищем в ответе модели готовый сайт.
   Сначала смотрим на файлы из маркеров — там сайт лежит целиком, со стилями
   и скриптами. Если файлов нет, ищем в тексте блок с полным HTML-документом. */
export function findSite(text, files) {
  if (Array.isArray(files) && files.length) {
    const html = files.filter((f) => /\.html?$/i.test(f.path || ''));
    if (html.length) {
      const out = {};
      for (const f of files) {
        const p = safePath(f.path);
        if (p) out[p] = String(f.content ?? '');
      }
      // Точкой входа считаем index.html, иначе первый попавшийся html
      const entry = Object.keys(out).find((p) => /(^|\/)index\.html?$/i.test(p))
        || safePath(html[0].path);
      if (entry && out[entry]) return { files: out, entry };
    }
    return null;
  }
  const fence = /```[a-zA-Z]*\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(String(text || '')))) {
    const code = m[1];
    if (/<!doctype\s+html/i.test(code) || (/<html[\s>]/i.test(code) && /<\/html\s*>/i.test(code))) {
      return { files: { 'index.html': code.trim() }, entry: 'index.html' };
    }
  }
  return null;
}

function titleOf(html) {
  const m = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(html || '');
  return (m ? m[1] : '').trim() || 'Сайт';
}

async function publishUnlocked(userId, site, planKey = 'free') {
  const total = Object.values(site.files).reduce((n, c) => n + Buffer.byteLength(c, 'utf8'), 0);
  if (total > MAX_SITE_BYTES) return { ok: false, error: 'сайт слишком большой' };

  const list = await readIndex(userId);
  const used = (await listSites(userId)).reduce((sum, item) => sum + Math.max(0, Number(item.bytes || 0)), 0);
  const storageLimit = hostingQuota(planKey).storageBytes;
  if (used + total > storageLimit) {
    return { ok: false, error: 'Хранилище хостинга заполнено. Удалите старый сайт и повторите публикацию.' };
  }
  const limit = siteLimit(planKey);
  if (list.length >= limit) {
    return { ok: false, error: `Достигнут лимит: ${limit} сайтов на вашем тарифе. Удалите старый сайт через /sites и повторите публикацию.` };
  }

  let slug = '';
  for (let i = 0; i < 20; i += 1) {
    const candidate = slugId();
    if (!(await readSite(candidate))) { slug = candidate; break; }
  }
  if (!slug) return { ok: false, error: 'не удалось выделить адрес сайта' };

  const title = titleOf(site.files[site.entry]);
  await writeSite(slug, {
    owner: String(userId), entry: site.entry, files: site.files,
    title, ts: Date.now(), bytes: total,
  });

  list.unshift({ slug, title, ts: Date.now(), bytes: total });
  try {
    await writeIndex(userId, list);
  } catch (error) {
    await deleteSite(slug).catch(() => undefined);
    throw error;
  }
  return { ok: true, slug, url: `${PUBLIC_URL}/s/${slug}`, title, bytes: total, limit, count: list.length, hosting: hostingUsage(used + total, planKey) };
}

export function publish(userId, site, planKey = 'free') {
  return serializeUserMutation(userId, () => publishUnlocked(userId, site, planKey));
}

export async function getFile(slug, path) {
  const site = await readSite(slug);
  if (!site) return null;
  const p = path ? safePath(path) : null;
  const key = p && site.files[p] !== undefined ? p : (!p ? site.entry : null);
  if (!key || site.files[key] === undefined) return null;
  return { content: site.files[key], type: typeOf(key), isEntry: key === site.entry };
}

export async function listSites(userId) {
  const list = await readIndex(userId);
  // Старые записи индекса создавались без размера. Подтягиваем метаданные из
  // самого сайта, чтобы панель управления одинаково показывала все публикации.
  return Promise.all(list.map(async (item) => {
    if (Number.isFinite(Number(item.bytes))) return item;
    const site = await readSite(item.slug);
    return site && site.owner === String(userId)
      ? { ...item, title: site.title || item.title, bytes: Number(site.bytes || 0) }
      : item;
  }));
}

async function renameSiteUnlocked(userId, slug, nextTitle) {
  const title = String(nextTitle || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!title) return { ok: false, error: 'Введите название сайта.' };
  const site = await readSite(slug);
  if (!site || site.owner !== String(userId)) return { ok: false, error: 'Сайт не найден.' };
  const previousTitle = site.title;
  site.title = title;
  await writeSite(slug, site);
  const list = await readIndex(userId);
  const item = list.find((entry) => entry.slug === slug);
  if (item) item.title = title;
  try {
    await writeIndex(userId, list);
  } catch (error) {
    site.title = previousTitle;
    await writeSite(slug, site).catch(() => undefined);
    throw error;
  }
  return { ok: true, slug, title };
}

export function renameSite(userId, slug, nextTitle) {
  return serializeUserMutation(userId, () => renameSiteUnlocked(userId, slug, nextTitle));
}

async function removeSiteUnlocked(userId, slug) {
  const site = await readSite(slug);
  if (!site || site.owner !== String(userId)) return false;
  const previousIndex = await readIndex(userId);
  await deleteSite(slug);
  try {
    await writeIndex(userId, previousIndex.filter((s) => s.slug !== slug));
  } catch (error) {
    await writeSite(slug, site).catch(() => undefined);
    throw error;
  }
  return true;
}

export function removeSite(userId, slug) {
  return serializeUserMutation(userId, () => removeSiteUnlocked(userId, slug));
}
