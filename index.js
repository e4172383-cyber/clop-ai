import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BOT_NAME, ensureDirs, WEB_HOST, WEB_PORT, initializeModelPromo } from './src/config.js';
import * as store from './src/store.js';
import * as tg from './src/telegram.js';
import { handleUpdate, recoverInterruptedImageJobs } from './src/bot.js';
import { startWeb } from './src/web.js';
import * as codexAuth from './src/codexauth.js';
import * as kimiAuth from './src/kimiauth.js';
import { healthCheck as healthCheckGpt } from './src/gpt.js';
import { setBotUsername } from './src/botinfo.js';

const args = process.argv.slice(2);
const noBot = args.includes('--no-bot');
const noWeb = args.includes('--no-web');

ensureDirs();
await store.load();
await initializeModelPromo(store.redisClient());

// На сервере (Render и т.д.) у Codex CLI нет своего интерактивного логина —
// авторизацию подсовываем через переменную окружения: base64 от auth.json,
// который codex login сохраняет локально. Пишем его в CODEX_HOME до первого
// вызова codex. Локально (уже залогинен через codex login) переменная не нужна.
// Вход поднимаем после загрузки хранилища: свежая копия лежит в Redis, а
// переменная окружения нужна лишь на самый первый запуск. Подробности — в
// src/codexauth.js.
await codexAuth.restore();
codexAuth.watch();
await kimiAuth.restore();
kimiAuth.watch();

if (!noWeb) startWeb({ reloadEachRequest: noBot });

async function startBot() {
  const auth = (process.env.BOT_TOKEN || '').trim();
  if (!auth) {
    console.error('[bot] BOT_TOKEN не задан. Создайте файл .env рядом с index.js — см. README.');
    if (noWeb) process.exit(1);
    return;
  }
  tg.setToken(auth);

  const healthGpt = await healthCheckGpt();
  console.log(healthGpt.ok ? `[gpt] codex cli: ${healthGpt.version}` : `[gpt] ВНИМАНИЕ: codex cli недоступен (${healthGpt.version})`);

  const me = await tg.api('getMe');
  setBotUsername(me.username);
  console.log(`[bot] ${BOT_NAME} запущен как @${me.username}`);

  try {
    await tg.api('setMyCommands', {
      commands: [
        { command: 'start', description: 'Главное меню' },
        { command: 'new', description: 'Новый чат' },
        { command: 'chats', description: 'Мои чаты' },
        { command: 'compact', description: 'Сжать контекст чата' },
        { command: 'model', description: 'Выбор модели' },
        { command: 'effort', description: 'Сила мышления' },
        { command: 'usage', description: 'Лимиты' },
        { command: 'plans', description: 'Тарифы' },
        { command: 'corporate', description: 'Корпоративные тарифы' },
        { command: 'team', description: 'Моя корпоративная команда' },
        { command: 'team_add', description: 'Пригласить участника' },
        { command: 'team_remove', description: 'Удалить участника' },
        { command: 'phone', description: 'Сохранить номер для приглашения' },
        { command: 'buy', description: 'Купить тариф' },
        { command: 'myapi', description: 'Мой личный API-ключ' },
        { command: 'download', description: 'Скачать Clop Code' },
        { command: 'image', description: 'Сгенерировать изображение' },
        { command: 'help', description: 'Помощь' },
      ],
    });
  } catch (e) {
    console.warn('[bot] setMyCommands:', e.message);
  }

  // Сбрасываем кастомную кнопку меню (Web App / текстовую), если она была
  // настроена раньше через BotFather — возвращаем стандартную "Меню команд"
  try {
    await tg.api('setChatMenuButton', { menu_button: { type: 'commands' } });
  } catch (e) {
    console.warn('[bot] setChatMenuButton:', e.message);
  }

  tg.pollUpdates(handleUpdate, { onError: (e) => console.error('[poll]', e.message) });
  recoverInterruptedImageJobs().catch((e) => console.error('[imagegen] восстановление:', e.message));
}

if (!noBot) await startBot();

const flush = async () => { try { await store.save(); } catch {} process.exit(0); };
process.on('SIGINT', flush);
process.on('SIGTERM', flush);
setInterval(() => { store.save().catch(() => {}); }, 60_000);

if (!noWeb) console.log(`[web] панель использования: http://${WEB_HOST}:${WEB_PORT}`);

// Само-пинг раз в минуту — держит бесплатный инстанс Render "живым" (не даёт
// заснуть от простоя). Бьёт в свой же /health — без пароля, без AI, ничего
// не считает. Работает только если задан SELF_URL (публичный адрес сервиса).
if (!noWeb && process.env.SELF_URL) {
  const pingUrl = process.env.SELF_URL.replace(/\/$/, '') + '/health';
  setInterval(() => {
    fetch(pingUrl).catch(() => {});
  }, 60_000);
  console.log(`[web] само-пинг каждую минуту: ${pingUrl}`);
}
