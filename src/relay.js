import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REQUEST_TIMEOUT_MS } from './config.js';

/* Ретранслятор GPT: сервер раздаёт задания, домашний компьютер их выполняет.

   Зачем. Вход в Codex по подписке ChatGPT держится на одноразовом токене
   обновления: каждое обновление выдаёт новый и отзывает прежний. Из
   дата-центра такой вход живёт минуты — OpenAI считает это раздачей доступа.
   Поэтому CLI переезжает туда, где вход законен: на компьютер владельца.

   Направление связи выбрано наоборот привычному: не сервер стучится к ПК, а ПК
   к серверу. Так не нужен ни белый адрес, ни проброс портов, ни дыра в
   домашнем маршрутизаторе.

   Очередь живёт в памяти намеренно. Задание имеет смысл, только пока запрос
   ждёт ответа: переживать перезапуск ему незачем, а Redis добавил бы способ
   выдать один и тот же ответ дважды. */

const TOKEN = process.env.RELAY_TOKEN || '';

// Сколько ретранслятор считается живым после последнего обращения. Он держит
// длинное ожидание на 25 секунд, так что минута молчания — уже потеря связи.
const ONLINE_MS = 70_000;

// Запас поверх таймаута самого CLI: дорога до дома и обратно тоже занимает время
const JOB_TIMEOUT_MS = REQUEST_TIMEOUT_MS + 20_000;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const jobs = new Map();     // id -> задание, которое кто-то ждёт
const queue = [];           // id заданий, ещё не отданных ретранслятору
const waiters = [];         // висящие запросы /relay/pull

let lastSeen = 0;
let lastAgent = '';
let served = 0, failed = 0;

const newId = () => crypto.randomBytes(9).toString('hex');

/* Сравнение секрета: обычное === выдаёт длину и первые совпавшие байты */
export function authorized(given) {
  if (!TOKEN) return false;
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

export const configured = () => Boolean(TOKEN);
export const online = () => Date.now() - lastSeen < ONLINE_MS;

export function status() {
  return {
    configured: configured(),
    online: online(),
    agent: lastAgent,
    lastSeen: lastSeen || null,
    waiting: queue.length,
    served,
    failed,
  };
}

/* Картинки лежат во временной папке сервера — на чужом компьютере таких путей
   нет, поэтому едут содержимым. Слишком большие тихо пропускаем: остаться без
   одной картинки лучше, чем уронить весь запрос. */
function packImages(paths = []) {
  const out = [];
  for (const p of paths) {
    try {
      const buf = fs.readFileSync(p);
      if (buf.length > MAX_IMAGE_BYTES) continue;
      out.push({ name: path.basename(p), data: buf.toString('base64') });
    } catch { /* исчезла — не беда */ }
  }
  return out;
}

function finish(id, result) {
  const j = jobs.get(id);
  if (!j) return false;
  jobs.delete(id);
  clearTimeout(j.timer);
  j.signal?.removeEventListener('abort', j.abort);
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  if (result?.ok) served++; else failed++;
  j.resolve(result);
  return true;
}

/**
 * Ставит задание в очередь и ждёт ответа от домашнего компьютера.
 * Возвращает тот же объект, что и codexrun.runCodex, — вызывающему коду
 * безразлично, где именно крутился CLI.
 */
export function run(job, onDelta, signal) {
  return new Promise((resolve) => {
    const id = newId();
    const payload = {
      id,
      modelCli: job.modelCli,
      fixedEffort: job.fixedEffort || null,
      hideIdentity: Boolean(job.hideIdentity),
      threadId: job.threadId || null,
      resumeStdin: job.resumeStdin,
      freshStdin: job.freshStdin,
      images: packImages(job.imagePaths),
    };
    const rec = {
      id, payload, onDelta, resolve,
      signal,
      created: Date.now(),
      timer: setTimeout(() => {
        console.error(`[relay] задание ${id} не дождалось ответа`);
        finish(id, { ok: false, error: 'ретранслятор не ответил вовремя' });
      }, JOB_TIMEOUT_MS),
    };
    jobs.set(id, rec);
    queue.push(id);
    rec.abort = () => finish(id, { ok: false, error: 'aborted' });
    if (signal?.aborted) rec.abort();
    else signal?.addEventListener('abort', rec.abort, { once: true });

    const w = waiters.shift();
    if (w) w();
  });
}

/**
 * Длинное ожидание задания. Держим соединение, пока задание не появится, —
 * иначе домашний агент молотил бы опросами вхолостую.
 */
export function pull(agent, waitMs = 25_000) {
  lastSeen = Date.now();
  if (agent) lastAgent = String(agent).slice(0, 60);

  const take = () => {
    while (queue.length) {
      const id = queue.shift();
      const rec = jobs.get(id);
      if (rec) { rec.taken = Date.now(); return rec.payload; }
    }
    return null;
  };

  const now = take();
  if (now) return Promise.resolve(now);

  return new Promise((resolve) => {
    let done = false;
    const wake = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(take());
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const i = waiters.indexOf(wake);
      if (i >= 0) waiters.splice(i, 1);
      resolve(null);
    }, waitMs);
    waiters.push(wake);
  });
}

/* Промежуточный текст: пользователь видит ответ по мере готовности кусков */
export function delta(id, text) {
  lastSeen = Date.now();
  const j = jobs.get(id);
  if (!j) return false;
  try { j.onDelta?.(String(text || '')); } catch { /* показ не критичен */ }
  return true;
}

export function deliver(id, result) {
  lastSeen = Date.now();
  return finish(id, result);
}
