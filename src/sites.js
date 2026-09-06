import { redisClient } from './store.js';
import { PUBLIC_URL } from './config.js';

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

export const MAX_SITE_BYTES = 1_000_000;
export const MAX_SITES_PER_USER = 60;

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

const slugId = () => Math.random().toString(36).slice(2, 9);

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
    return null;
  }
}

async function writeSite(slug, site) {
  const r = redisClient();
  if (!r) { mem.set(slug, site); return true; }
  try { await r.set(KEY(slug), site); return true; } catch (e) {
    console.error('[sites] запись не удалась', e.message);
    return false;
  }
}

async function readIndex(uid) {
  const r = redisClient();
  if (!r) return memIdx.get(String(uid)) || [];
  try { return (await r.get(IDX(uid))) || []; } catch { return []; }
}

async function writeIndex(uid, list) {
  const r = redisClient();
  if (!r) { memIdx.set(String(uid), list); return; }
  try { await r.set(IDX(uid), list); } catch (e) { console.error('[sites] индекс', e.message); }
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

export async function publish(userId, site) {
  const total = Object.values(site.files).reduce((n, c) => n + Buffer.byteLength(c, 'utf8'), 0);
  if (total > MAX_SITE_BYTES) return { ok: false, error: 'сайт слишком большой' };

  const list = await readIndex(userId);
  if (list.length >= MAX_SITES_PER_USER) {
    return { ok: false, error: `можно хранить не больше ${MAX_SITES_PER_USER} сайтов — удалите старые через /sites` };
  }

  let slug = slugId();
  for (let i = 0; i < 5 && (await readSite(slug)); i++) slug = slugId();

  const title = titleOf(site.files[site.entry]);
  const ok = await writeSite(slug, {
    owner: String(userId), entry: site.entry, files: site.files,
    title, ts: Date.now(), bytes: total,
  });
  if (!ok) return { ok: false, error: 'не удалось сохранить сайт' };

  list.unshift({ slug, title, ts: Date.now() });
  await writeIndex(userId, list);
  return { ok: true, slug, url: `${PUBLIC_URL}/s/${slug}`, title, bytes: total };
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
  return readIndex(userId);
}

export async function removeSite(userId, slug) {
  const site = await readSite(slug);
  if (!site || site.owner !== String(userId)) return false;
  const r = redisClient();
  if (r) { try { await r.del(KEY(slug)); } catch (e) { console.error('[sites] удаление', e.message); } }
  else mem.delete(slug);
  await writeIndex(userId, (await readIndex(userId)).filter((s) => s.slug !== slug));
  return true;
}
