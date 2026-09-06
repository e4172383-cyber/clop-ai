#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runJob } from '../src/codexrun.js';

/* Ретранслятор GPT — домашняя половина.

   Запускается на компьютере, где выполнен вход в Codex по подписке ChatGPT.
   Сам ходит на сервер за заданиями, гоняет CLI и возвращает ответ. Наружу не
   слушает ни одного порта: связь всегда исходящая, поэтому ни белый адрес, ни
   проброс портов не нужны, а домашняя сеть остаётся закрытой.

   Запуск:
     set RELAY_TOKEN=<тот же секрет, что в переменных Render>
     node relay/agent.mjs

   Адрес сервера при необходимости задаётся RELAY_URL. */

const здесь = path.dirname(fileURLToPath(import.meta.url));

/* Настройки берём из переменных окружения, а если их нет — из relay/local.json
   рядом со скриптом. Второе удобнее для ярлыка на рабочем столе: секрет лежит
   в файле, а не в свойствах ярлыка, где его видно всем. */
function настройки() {
  let файл = {};
  try { файл = JSON.parse(fs.readFileSync(path.join(здесь, 'local.json'), 'utf8')); } catch { /* необязателен */ }
  return {
    url: (process.env.RELAY_URL || файл.url || 'https://clop-ai.onrender.com').replace(/\/+$/, ''),
    token: process.env.RELAY_TOKEN || файл.token || '',
    name: process.env.RELAY_NAME || файл.name || os.hostname(),
    // Сколько заданий тянем разом: одно медленное не должно держать остальные
    parallel: Number(process.env.RELAY_PARALLEL || файл.parallel || 2),
  };
}

const cfg = настройки();
if (!cfg.token) {
  console.error('Нет секрета. Задайте RELAY_TOKEN или положите relay/local.json с полем token.');
  process.exit(1);
}
// Секрет едет в заголовке HTTP, а туда пускают только ASCII. Кириллица там
// падает с невнятной ошибкой про ByteString — лучше сказать прямо и сразу.
if (!/^[!-~]+$/.test(cfg.token)) {
  console.error('Секрет должен состоять из латиницы, цифр и знаков — заголовок HTTP другого не принимает.');
  process.exit(1);
}

const IMG_DIR = path.join(os.tmpdir(), 'clop-relay');

const запрос = async (путь, опции = {}) => {
  const r = await fetch(cfg.url + путь, {
    ...опции,
    headers: {
      'x-relay-token': cfg.token,
      ...(опции.body ? { 'content-type': 'application/json' } : {}),
      ...(опции.headers || {}),
    },
  });
  if (r.status === 401) throw new Error('сервер не принял секрет');
  return r.json();
};

/* Картинки приходят содержимым: путей сервера на этом компьютере нет */
function разложитьКартинки(images = []) {
  if (!images.length) return [];
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const пути = [];
  for (const im of images) {
    const имя = crypto.randomBytes(6).toString('hex') + path.extname(im.name || '.png');
    const p = path.join(IMG_DIR, имя);
    fs.writeFileSync(p, Buffer.from(im.data, 'base64'));
    пути.push(p);
  }
  return пути;
}

const убрать = (пути) => { for (const p of пути) { try { fs.unlinkSync(p); } catch { /* и ладно */ } } };

async function выполнить(job) {
  const начало = Date.now();
  console.log(`[агент] задание ${job.id}: ${job.modelCli}${job.threadId ? ' (продолжение)' : ''}`);
  const пути = разложитьКартинки(job.images);

  // Промежуточный текст шлём не чаще раза в секунду: Codex отдаёт готовые
  // куски, а не токены, но повторов всё равно хватает, чтобы засорить канал
  let последний = 0, вОчереди = null, летит = false;
  const отправитьКусок = async (text) => {
    if (летит) { вОчереди = text; return; }
    летит = true;
    try { await запрос('/relay/delta', { method: 'POST', body: JSON.stringify({ id: job.id, text }) }); }
    catch { /* показ не критичен */ }
    летит = false;
    if (вОчереди !== null) { const t = вОчереди; вОчереди = null; отправитьКусок(t); }
  };
  const onDelta = (text) => {
    const сейчас = Date.now();
    if (сейчас - последний < 1000) { вОчереди = text; return; }
    последний = сейчас;
    отправитьКусок(text);
  };

  let result;
  try {
    result = await runJob({ ...job, imagePaths: пути }, onDelta);
  } catch (e) {
    result = { ok: false, error: 'агент: ' + (e.message || e) };
  }
  убрать(пути);

  // Ответ сервера ждём: если не дошёл — задание там всё равно отвалится по
  // таймауту, но лишний повтор в CLI обошёлся бы дороже
  try {
    await запрос('/relay/result', { method: 'POST', body: JSON.stringify({ id: job.id, result }) });
  } catch (e) {
    console.error(`[агент] не смог отдать ответ ${job.id}: ${e.message || e}`);
  }
  const сек = ((Date.now() - начало) / 1000).toFixed(1);
  console.log(`[агент] задание ${job.id} готово за ${сек} с: ${result.ok ? 'успех' : 'ошибка — ' + (result.errMsg || result.error || 'без причины')}`);
}

async function поток(номер) {
  let пауза = 1000;
  for (;;) {
    try {
      const r = await запрос(`/relay/pull?agent=${encodeURIComponent(cfg.name)}`);
      пауза = 1000;
      if (r && r.job) await выполнить(r.job);
    } catch (e) {
      console.error(`[агент ${номер}] нет связи: ${e.message || e} — жду ${Math.round(пауза / 1000)} с`);
      await new Promise((r) => setTimeout(r, пауза));
      // Плавно отступаем, но не дальше минуты: сервер может просто просыпаться
      пауза = Math.min(пауза * 2, 60_000);
    }
  }
}

console.log(`[агент] «${cfg.name}» подключается к ${cfg.url}, потоков: ${cfg.parallel}`);
for (let i = 1; i <= Math.max(1, cfg.parallel); i++) поток(i);
