import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { redisClient } from './store.js';

/* Живучесть входа в Codex.

   У Codex токен обновления одноразовый: при каждом обновлении выдаётся новый,
   а прежний тут же отзывается. CLI хранит его в auth.json и переписывает файл
   молча.

   Раньше сервер брал auth.json только из переменной окружения — снимка,
   сделанного руками когда-то давно. Диск Render живёт до перезапуска, поэтому
   после первого же обновления токена и последующего рестарта сервер
   возвращался к отозванному снимку и все GPT-модели отваливались с «refresh
   token was revoked».

   Теперь свежий файл складывается в Redis (он переживает перезапуски), а при
   старте берётся оттуда.

   Но у переменной окружения есть право старшинства: если её значение
   изменилось, значит человек только что заменил вход руками — например,
   потому что копия в Redis протухла. Слепо предпочитать Redis в такой
   ситуации значило бы намертво игнорировать починку. Поэтому рядом с копией
   держим отпечаток переменной, из которой она выросла: не совпал — берём
   переменную и пересеваем Redis заново. */

const KEY = 'clop:codexauth';
const SEED = 'clop:codexauth:seed';
const home = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const file = () => path.join(home(), 'auth.json');

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
let lastSaved = null;

function write(buf, откуда) {
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(file(), buf);
  lastSaved = hash(buf);
  console.log(`[codex] вход восстановлен ${откуда} (${buf.length} байт)`);
}

/* Поднимает вход при старте: сначала Redis, затем переменная окружения. */
export async function restore() {
  const b64 = process.env.CODEX_AUTH_JSON_B64;
  const seedNow = b64 ? hash(Buffer.from(b64, 'utf8')) : null;
  const r = redisClient();

  if (r) {
    try {
      const [saved, seedWas] = await Promise.all([r.get(KEY), r.get(SEED)]);
      const переменнаяСменилась = Boolean(seedNow) && seedNow !== seedWas;
      if (saved && typeof saved === 'string' && saved.length > 100 && !переменнаяСменилась) {
        write(Buffer.from(saved, 'base64'), 'из Redis');
        return true;
      }
      if (переменнаяСменилась) console.log('[codex] переменная окружения изменилась — берём её, копию пересеваем');
    } catch (e) {
      console.warn('[codex] не удалось прочитать вход из Redis:', e.message);
    }
  }

  if (b64) {
    try {
      write(Buffer.from(b64, 'base64'), 'из переменной окружения');
      // write() marks the local file as seen, but the new login is not in
      // Redis yet. Force this first save before recording the new seed.
      lastSaved = null;
      await save();
      if (r && seedNow) { try { await r.set(SEED, seedNow); } catch { /* не критично */ } }
      return true;
    } catch (e) {
      console.warn('[codex] не удалось восстановить вход:', e.message);
    }
  }
  return false;
}

/* Сохраняет текущий файл, если он изменился с прошлого раза. */
export async function save() {
  const r = redisClient();
  if (!r) return false;
  let buf;
  try { buf = fs.readFileSync(file()); } catch { return false; }
  const h = hash(buf);
  if (h === lastSaved) return false;
  try {
    await r.set(KEY, buf.toString('base64'));
    lastSaved = h;
    console.log('[codex] обновлённый вход сохранён — переживёт перезапуск');
    return true;
  } catch (e) {
    console.warn('[codex] не удалось сохранить вход:', e.message);
    return false;
  }
}

/* Следим за файлом: CLI переписывает его молча, а нам важно не упустить
   свежий токен — иначе перезапуск снова вернёт отозванный. */
export function watch(everyMs = 60_000) {
  setInterval(() => { save().catch(() => {}); }, everyMs).unref();
}
