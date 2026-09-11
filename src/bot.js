import { BOT_NAME, PUBLIC_URL, MODELS, PLANS, PROVIDERS, EFFORTS, DEFAULT_MODEL, MAX_CHATS, OPUS_FREE_PROMO_UNTIL, FREE_GO_UNTIL, freeGoActive, MODEL_PROMO, modelPromoActive, modelInPromo, IMAGE_GENERATORS, ADMIN_IDS, CORPORATE_PLANS, corporatePlan, corporatePlansReady, modelRatings } from './config.js';
import * as tg from './telegram.js';
import * as store from './store.js';
import { planOf, effortOf, allowedEffortOptions, checkLimits, checkAllLimits, bar, humanLeft, imageLimitState } from './limits.js';
import { availablePlans, selectModel } from './model-policy.js';
import { ask as gptAsk } from './gpt.js';
import { ask as kimiAsk } from './kimi.js';
import { runModelJob } from './model-queue.js';
import { generateImage } from './image.js';
import { BILLING_VERSION } from './token-accounting.js';
import { wantsGeneratedImage } from './image-intent.js';
import { createImageJob, imageJobRecoveryAction, prepareImageJobRetry } from './image-job.js';
import { addOfferUsage, claimOffer, offerActiveFor, offerState } from './limited-offer.js';
import { recordProviderResult } from './provider-status.js';

const DESKTOP_RELEASE = Object.freeze({
  version: '2.5.4',
  released: '11.09.2026',
  windows: 'Clop-Code-Setup-2.5.4.exe',
  linux: 'Clop-Code-2.5.4-linux-x64.tar.xz',
  androidVersion: '1.0.7',
  android: 'Clop-AI-Mobile-1.0.7.apk',
});

// Единая точка входа: Claude-модели идут через Claude CLI, GPT-модели — через
// Codex CLI. Возвращаемая форма одинаковая для обоих (ok/text/tokens/...).
// Отказ входа у провайдера ни при чём для пользователя: он видел бы чужую
// английскую ошибку про токен и не понял бы, что делать
const AUTH_BROKEN = /revoked|refresh|unauthorized|401|not logged in|log in again|re-login|no credential configured|authorization grant is invalid|invalid_grant/i;

export async function askModel({ chat, model, effortKey, prompt, onDelta, images, fast = false, signal, client = 'chat', userId = null }) {
  return runModelJob(async () => {
    const workingChat = { ...chat, messages: [...(chat.messages || [])] };
    let modelCalls = 0;
    const invokeModel = async (nextPrompt, nextDelta = undefined) => {
      const callImages = modelCalls === 0 ? images : undefined;
      modelCalls += 1;
      let result;
      if (model?.runtime === 'kimi') {
        const r = await kimiAsk({ chat: workingChat, modelCli: model.cli, kimiEffort: model.kimiEffort, prompt: nextPrompt, onDelta: nextDelta, signal, client });
        recordProviderResult('kimi', r);
        result = !r.ok && AUTH_BROKEN.test(String(r.error || ''))
          ? { ...r, provider: 'kimi', error: 'Вход Kimi временно недоступен. Владелец сервиса уже может проверить авторизацию.' }
          : { ...r, provider: 'kimi' };
      } else {
        const selected = model?.runtime === 'gpt' || model?.provider === 'gpt' ? model : MODELS[DEFAULT_MODEL];
        const r = await gptAsk({ chat: workingChat, modelCli: selected.cli, prompt: nextPrompt, onDelta: nextDelta, images: callImages,
          fixedEffort: selected.fixedEffort || (selected.supportsEffort ? effortKey : undefined),
          hideIdentity: selected.hideIdentity, identityTitle: selected.hideIdentity ? selected.title : undefined,
          fast, signal });
        recordProviderResult(selected.provider, r);
        result = !r.ok && AUTH_BROKEN.test(String(r.error || ''))
          ? { ...r, provider: selected.provider, runtime: 'gpt', error: 'Модель временно недоступна. Владелец сервиса уже может проверить подключение.' }
          : { ...r, provider: selected.provider, runtime: 'gpt' };
      }
      if (result.ok) {
        if (result.runtime === 'gpt' && result.threadId) workingChat.gptThreadId = result.threadId;
        workingChat.messages.push({ role: 'user', content: nextPrompt }, { role: 'assistant', content: result.text });
      }
      return result;
    };

    return invokeModel(prompt, onDelta);
  }, signal);
}
import * as sites from './sites.js';
import * as desk from './desktop.js';
import { extractFiles } from './files.js';
import * as vision from './vision.js';
import * as support from './support.js';
import { enterSupportMode, isSupportModeActive, leaveSupportMode, leaveTransientModes } from './conversation-modes.js';
import { isOffice, extractOffice } from './docs.js';
import { buildZip } from './zip.js';
import { claimApiKey, resetApiKey, syncPlan, cloudEnabled } from './cloud.js';
import { claimCode } from './weblogin.js';
import { STARS_PER_USD, MIN_TOPUP_STARS, MAX_TOPUP_STARS, starsToMicros, microsToUsd, purchaseBonus } from './billing.js';
import { getServerMetrics, formatServerStatus } from './server-metrics.js';

const busy = new Set();
const siteQuotaPlan = (u) => planOf(u).key;

// Render работает в UTC, поэтому часовой пояс указываем явно. Иначе даты в
// сообщениях бота отстают от времени пользователя в Киеве.
const dt = (ts) => new Date(ts).toLocaleString('ru-RU', {
  timeZone: 'Europe/Kyiv',
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

// Анонс скорого релиза — баннер в главном меню, до даты выхода
const UPCOMING_RELEASE = {
  title: 'Clop 1.1 Haiku',
  desc: '128-символьная модель',
  at: new Date(2026, 7, 29, 23, 0, 0).getTime(), // 29.08.2026 23:00
};

// "Живая" анимация мышления/печати
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const LIVE_PREVIEW_LIMIT = 3500; // Telegram-лимит на сообщение — 4096
const LIVE_EDIT_MIN_MS = 1200; // не чаще, чтобы не упереться в рейт-лимит Telegram
const FILE_MARK_RE = /%%%FILE\s+([^\n%]+?)\s*%%%/g;
const FILE_END_RE = /%%%ENDFILE%%%/g;

// Загрузка файлов: принимаем только текстовые — по расширению или mime
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'yml', 'yaml', 'xml',
  'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'ps1', 'bat',
  'sql', 'ini', 'cfg', 'conf', 'env', 'toml', 'r', 'swift', 'dart', 'lua', 'pl',
]);
const MAX_DOC_BYTES = 2 * 1024 * 1024; // 2 МБ на скачивание
const MAX_DOC_CHARS = 60_000; // дальше срезаем, чтобы не сожрать контекст одним файлом

// Список тарифов, которым доступна модель прямо сейчас — с учётом временных
// акций (например Opus 5 сегодня открыт и для free, лимиты при этом как обычно)
export function modelPlans(m) {
  return availablePlans(m, Object.keys(PLANS), MODEL_PROMO);
}

export function modelAvailableTo(u, m) {
  return Boolean(m && (modelPlans(m).includes(planOf(u).key) || offerActiveFor(u, m.key)));
}

export function modelOf(u) {
  const selected = MODELS[u.model] || MODELS[DEFAULT_MODEL];
  return modelAvailableTo(u, selected) ? selected : MODELS[DEFAULT_MODEL];
}

// Заполненность контекстного окна МОДЕЛИ (не лимита тарифа) для этого чата
function contextPercent(chat, model) {
  const used = chat.contextTokens || 0;
  const window = model.contextWindow || 1_000_000;
  return Math.min(100, Math.round((used / window) * 100));
}

function compactChat(chat) {
  chat.sessionId = null;
  chat.messages = [];
  chat.contextTokens = 0;
  chat.heavyWarned = false;
  chat.updatedAt = Date.now();
  store.saveSoon();
}

/* ---------------- keyboards ---------------- */

function mainKb(u) {
  const m = modelOf(u);
  const offer = offerState(u);
  const trial = store.goTrialState(u);
  const showOffer = offer && (!offer.claimed || offer.active);
  const effortLabel = m.supportsEffort === false ? 'не нужно' : effortOf(u, m).short;
  return {
    inline_keyboard: [
      [{ text: '💬 Новый чат', callback_data: 'new_chat' }, { text: '📂 Мои чаты', callback_data: 'chats' }],
      [{ text: `🤖 Модель: ${m.short}`, callback_data: 'model' }, { text: `🧠 Мышление: ${effortLabel}`, callback_data: 'effort' }],
      ...(m.provider === 'gpt' ? [[{ text: `⚡ Быстро: ${u.fast ? 'ВКЛ' : 'ВЫКЛ'}`, callback_data: 'fast_toggle' }]] : []),
      [{ text: '📊 Лимиты', callback_data: 'usage' }, { text: '💎 Тарифы', callback_data: 'plans' }],
      [{ text: trial.eligible ? '🎁 Получить пробный GO на 1 день' : trial.active ? '⚡ Пробный GO уже активен' : trial.used ? '✓ Пробный GO уже использован' : '🎁 Пробный GO на 1 день', callback_data: 'trial_go' }],
      [{ text: '🏢 Моя команда', callback_data: 'team' }],
      ...(showOffer ? [[{ text: offer.claimed ? '🎁 Бонус Astra + Kimi активен' : '🎁 Получить бонус Astra + Kimi', callback_data: 'offer_claim' }]] : []),
      [{ text: '🖼 Сгенерировать (бета)', callback_data: 'imagegen' }],
      [{ text: '🌐 Чат на сайте (бета)', url: `${PUBLIC_URL}/chat` }],
      [{ text: '🖥 Состояние сервера', callback_data: 'server_status' }],
      [{ text: `💻 Скачать Clop Code · v${DESKTOP_RELEASE.version}`, callback_data: 'app_download' }],
      [{ text: '🔑 Мой API', callback_data: 'myapi' }, { text: '❓ Помощь', callback_data: 'help' }],
      [{ text: '🐞 Баг?', callback_data: 'bug_report' }, { text: '🛟 Поддержка', callback_data: 'support' }],
      [{ text: `🎁 Бонусы: ${store.bonusBalance(u)}`, callback_data: 'bonus' }],
    ],
  };
}

const backKb = (extra = []) => ({ inline_keyboard: [...extra, [{ text: '⬅️ В меню', callback_data: 'menu' }]] });

function modelKb(u) {
  const plan = planOf(u);
  const rows = Object.values(MODELS).map((m) => {
    const locked = !modelAvailableTo(u, m);
    const active = modelOf(u).key === m.key;
    const label = `${active ? '✅ ' : locked ? '🔒 ' : '▫️ '}${m.title}${m.recommended ? ' ⭐' : ''}`;
    return [{ text: label, callback_data: locked ? 'need_plan:' + m.key : 'model_set:' + m.key }];
  });
  if (plan.key === 'free') rows.push([{ text: '💎 Открыть все модели — тарифы', callback_data: 'plans' }]);
  return backKb(rows);
}

function effortKb(u) {
  const model = modelOf(u);
  if (model.supportsEffort === false) {
    return backKb([[{ text: '🤖 Сменить модель', callback_data: 'model' }]]);
  }
  const plan = planOf(u);
  if (plan.effort.locked) {
    return backKb([[{ text: '💎 Открыть выбор — Pro', callback_data: 'plans' }]]);
  }
  const current = effortOf(u, model).key;
  const rows = allowedEffortOptions(u, model).map((key) => {
    const e = EFFORTS[key];
    const active = key === current;
    return [{ text: `${active ? '✅ ' : '▫️ '}${e.title}`, callback_data: 'effort_set:' + key }];
  });
  return backKb(rows);
}

function chatsKb(u) {
  const rows = store.liveChats(u).slice(0, MAX_CHATS).map((c) => [
    { text: (c.id === u.activeChatId ? '🟢 ' : '💬 ') + c.title.slice(0, 30), callback_data: 'chat:' + c.id },
    { text: '🗑', callback_data: 'chat_del:' + c.id },
  ]);
  rows.push([{ text: '➕ Новый чат', callback_data: 'new_chat' }]);
  return backKb(rows);
}

/* ---------------- texts ---------------- */

function usageText(u) {
  const plan = planOf(u);
  const all = checkAllLimits(u);
  const offer = offerState(u);
  const activeTeam = store.activeTeamFor(u);
  const planUntil = activeTeam?.until || u.proUntil || 0;
  const lines = [
    `📊 *Использование*`,
    `Тариф: ${plan.emoji} *${plan.title}*${planUntil ? ` (до ${dt(planUntil)})` : ''}`,
    '',
  ];
  if (offer?.claimed && Date.now() < offer.until) {
    lines.push('🎁 *Бонусные токены акции*');
    for (const key of offer.models || []) {
      const total = Math.max(1, Math.round(Number(offer.budgets?.[key]) || 0));
      const used = Math.max(0, Math.round(Number(offer.usedByModel?.[key]) || 0));
      const percent = Math.min(100, Math.round((used / total) * 100));
      lines.push(`${MODELS[key]?.title || key}: ${bar(percent)} *${percent}%*`);
    }
    lines.push(`Доступны до *${dt(offer.until)} по Киеву*`);
    lines.push('');
  }
  if (activeTeam) {
    lines.push('🏢 *Корпоративный пул*');
    for (const s of all.shared.states) {
      lines.push(`${s.title}`);
      lines.push(`${bar(s.percent)} ${s.percent}%`);
      lines.push(s.exceeded
        ? `⛔️ лимит исчерпан · обновится через ${humanLeft(s.resetAt - Date.now())}`
        : `осталось ${s.left}%${s.percent > 0 ? ` · окно сдвинется через ${humanLeft(s.resetAt - Date.now())}` : ''}`);
    }
    lines.push('');
  }
  if (!activeTeam) {
    lines.push('⚖️ *Общий лимит всех моделей*');
    for (const s of all.shared.states) {
      lines.push(`${s.title}`);
      lines.push(`${bar(s.percent)} ${s.percent}%`);
      lines.push(s.exceeded
        ? `⛔️ лимит исчерпан · обновится через ${humanLeft(s.resetAt - Date.now())}`
        : `осталось ${s.left}%${s.percent > 0 ? ` · окно сдвинется через ${humanLeft(s.resetAt - Date.now())}` : ''}`);
    }
    lines.push('');
  }
  const curModel = modelOf(u);
  lines.push(`Модель: *${curModel.title}*`);
  const rating = modelRatings(curModel);
  lines.push(`Цена: *${rating.price}/5* · Скорость: *${rating.speed}/5* · Качество: *${rating.quality}/5*`);
  lines.push(`Сила мышления: *${curModel.supportsEffort === false ? 'своё встроенное размышление' : effortOf(u, curModel).title}*`);
  const activeChat = store.activeChat(u, false);
  if (activeChat) {
    const cp = contextPercent(activeChat, curModel);
    lines.push(`Контекст чата: *${cp}%*${cp >= 90 ? ' — скоро понадобится /compact' : ''}`);
  }
  lines.push(`Чатов: *${store.liveChats(u).length}* · запросов всего: *${u.stats.requests}*`);
  const img = imageLimitState(u);
  lines.push(`🖼 Картинки (бета): *${img.used}/${img.limit}* сегодня`);
  if (plan.key !== 'max20') lines.push('\n💎 Смотрите /plans — тарифы с бóльшим лимитом.');
  return lines.join('\n');
}


function plansText(u) {
  const currentPlan = planOf(u);
  const trial = store.goTrialState(u);
  const cur = currentPlan.corporateKey || currentPlan.key;
  const block = (p) => [
    `${p.emoji} *${p.title}*${p.key === cur ? ' — ваш тариф' : ''}${p.stars ? ` — ${p.stars} ⭐️ / ${p.days} дней` : ' — 0 ⭐️'}`,
    ...p.perks.map((x) => `• ${x}`),
    `• Единый расход бота, сайта и личного API`,
    `• Остаток показывается в /usage только в процентах`,
  ].join('\n');
  return [
    '💎 *Тарифы Clop ai*',
    ...(freeGoActive()
      ? ['', `🎁 *Акция: тариф GO бесплатно всем до ${dt(FREE_GO_UNTIL)}* — он уже включён, покупать ничего не нужно.`]
      : []),
    ...(trial.active
      ? ['', `⚡ *Пробный GO активен до ${dt(trial.endsAt)}.* После этого для продолжения потребуется покупка тарифа.`]
      : trial.eligible
        ? ['', '🎁 *Пробный GO на 24 часа* — можно активировать один раз без оплаты. После окончания доступна обычная покупка.']
        : trial.used
          ? ['', '✓ Пробный период GO уже использован.']
          : ['', '🎁 *Пробный GO на 1 день* доступен один раз бесплатным аккаунтам без активной подписки.']),
    '',
    Object.values(PLANS).map(block).join('\n\n'),
    '',
    '_Оплата — звёздами Telegram. Тариф активируется сразу после оплаты._',
  ].join('\n');
}

function imageGenKb() {
  const rows = Object.values(IMAGE_GENERATORS).map((g) => [{ text: `🖼 ${g.title}`, callback_data: 'imagegen_pick:' + g.key }]);
  return backKb(rows);
}

function imageGenText(u) {
  const lim = imageLimitState(u);
  const lines = [
    '🖼 *Генерация изображений (бета)*',
    '',
    `Лимит на тарифе ${planOf(u).title}: *${lim.limit} в сутки*, осталось сегодня: *${lim.left}*.`,
    '',
  ];
  if (lim.exceeded) {
    lines.push('⛔️ Лимит на сегодня исчерпан — попробуйте завтра или смотрите /plans.');
    return lines.join('\n');
  }
  lines.push('Выберите, где генерировать:');
  return lines.join('\n');
}

function myApiKb() {
  return backKb([[{ text: '♻️ Сбросить ключ (старый перестанет работать)', callback_data: 'myapi_reset' }]]);
}

function apiKeyText(res) {
  const base = (process.env.CLOUD_API_URL || PUBLIC_URL).replace(/\/+$/, '');
  return [
    '🔑 *Ваш личный API*',
    '',
    res.reused ? 'Это ваш уже выданный ключ.' : (res.wasReset ? 'Старый ключ отозван, вот новый.' : 'Ключ выдан.'),
    '',
    `*Ключ:* \`${res.apiKey}\``,
    '',
    'Поддерживается несколько форматов URL — используйте тот, что понимает ваш инструмент/сайт:',
    '',
    '*1) Свой простой формат:*',
    '```',
    `POST ${base}/v1/ask`,
    'Content-Type: application/json',
    `x-api-key: ${res.apiKey}`,
    '',
    '{"prompt": "текст вопроса", "sessionId": "необязательно"}',
    '```',
    'Ответ: `{"ok": true, "text": "...", "sessionId": "..."}`',
    '',
    '*Файлы (хранятся 24 часа):*',
    `\`POST ${base}/v1/files\` — JSON/base64 \`{"filename":"hello.txt","mime_type":"text/plain","file_data":"aGVsbG8="}\` или \`multipart/form-data\` с полем \`file\`.`,
    'В ответе придёт `id`; используйте его как `file_id` в `/v1/ask`: `"attachments":[{"file_id":"file_..."}]`.',
    'Созданные ИИ файлы находятся в `artifacts[]`; `download_url` открывается с тем же API-ключом.',
    '',
    '*2) OpenAI-совместимый (`/v1/chat/completions`)* — для OpenCode, Cursor, LibreChat и т.п.:',
    '```',
    `POST ${base}/v1/chat/completions`,
    `Authorization: Bearer ${res.apiKey}`,
    '',
    '{"model": "sonnet-5", "messages": [{"role": "user", "content": "привет"}]}',
    '```',
    '',
    '*3) Anthropic-совместимый (`/v1/messages`)* — для сайтов, ожидающих нативный формат Claude API:',
    '```',
    `POST ${base}/v1/messages`,
    `x-api-key: ${res.apiKey}`,
    '',
    '{"model": "sonnet-5", "messages": [{"role": "user", "content": "привет"}]}',
    '```',
    '',
    // Доступны и Claude, и GPT. Модель можно указывать как коротким id, так и
    // настоящим именем (claude-opus-5, gpt-5.6-sol) — принимаются оба.
    // Для Clop-моделей показываем только публичный id и название; служебное
    // имя запуска остаётся внутренней деталью.
    '*Модели* (в поле `"model"` — короткий id или полное имя):',
    ...Object.values(MODELS).map((m) => m.hideIdentity
      ? `• \`${m.key}\` — ${m.title}`
      : `• \`${m.key}\` / \`${m.cli}\` — ${m.title}`),
    '',
    `\`GET ${base}/v1/models\` с тем же \`x-api-key\` — список моделей с пометкой, какие доступны именно вам.`,
    '',
    '⚠️ Расход через API идёт в тот же общий лимит, что и бот. У каждой модели свой коэффициент потребления.',
  ].join('\n');
}

async function myApiText(u) {
  if (!cloudEnabled()) return '⚠️ Облачный API сейчас недоступен, попробуйте позже.';
  const res = await claimApiKey(u.id, planOf(u).key);
  if (!res || !res.apiKey) return '⚠️ Не удалось получить ключ — облачный сервис недоступен. Попробуйте позже.';
  u.cloudKey = true;
  store.saveSoon();
  return apiKeyText(res);
}

// Раз в несколько минут напоминаем облаку актуальный тариф каждого, кто
// когда-либо получал API-ключ — чтобы доступ к моделям/лимитам не откатился
// на free по таймауту, даже если человек давно не писал в сам бот
setInterval(() => {
  if (!cloudEnabled()) return;
  for (const u of store.allUsers()) {
    if (u.cloudKey) syncPlan(u.id, planOf(u).key);
  }
}, 4 * 60_000);

function helpText() {
  return [
    `❓ *${BOT_NAME} — справка*`,
    '',
    'Просто напишите сообщение — я отвечу. Контекст чата сохраняется.',
    '',
    '*Команды*',
    '/new — новый чат',
    '/chats — список чатов',
    '/compact — сжать (очистить) контекст текущего чата',
    '/model — выбрать модель',
    '/effort — сила мышления',
    '/usage — лимиты в процентах',
    '/image описание — сразу сгенерировать и прикрепить изображение',
    '/plans — тарифы',
    '/team — корпоративная команда',
    '/team_add @username — пригласить участника',
    '/team_remove @username — удалить участника',
    '/phone — сохранить свой номер для приглашения',
    '/buy — купить Pro',
    '/myapi — получить свой личный API-ключ (можно сбросить/перевыпустить кнопкой)',
    '/balance — баланс API и пополнение через Telegram Stars',
    '/download — скачать Clop Code для Windows или Linux',
    '/menu — главное меню',
    '',
    '*Контекст*',
    'У каждой модели своё окно контекста (память диалога). Когда чат заполняется под завязку (~99%), бот сам предупредит — используйте /compact, чтобы очистить контекст и продолжить в том же чате с чистого листа.',
    '',
    '*Модели*',
    ...Object.values(MODELS).map(m => `• *${m.title}* — ${m.desc}`),
    '',
    '*Сила мышления*',
    `На бесплатном тарифе доступны: ${PLANS.free.effort.options.map((k) => EFFORTS[k].title).join(', ')}.`,
    `На платных — ещё и: ${PLANS.pro.effort.options.filter((k) => !PLANS.free.effort.options.includes(k)).map((k) => EFFORTS[k].title).join(', ')}.`,
  ].join('\n');
}

function helpKb() {
  return backKb([[{ text: '©️ Документация авторских прав', callback_data: 'copyright' }]]);
}

function appDownloadText() {
  return [
    '💻 *Приложения Clop*', '',
    `Актуальная версия: *${DESKTOP_RELEASE.version}*`,
    `Выпуск: ${DESKTOP_RELEASE.released}`, '',
    'Один Telegram-аккаунт, общие модели, подписка и лимиты с ботом и сайтом.', '',
    '🪟 *Windows 10/11 x64* — установщик EXE.',
    '🐧 *Linux x64* — архив tar.xz. Распакуйте его и запустите файл `clop-code`.', '',
    `📱 *Android 8+* — APK версии ${DESKTOP_RELEASE.androidVersion}: быстрый чат, файлы, камера, демонстрация экрана и плавающая кнопка.`, '',
    'В Linux доступны чат, файлы и терминал. Управление экраном и мышью пока поддерживается только в Windows.',
  ].join('\n');
}

function appDownloadKb() {
  const root = `${PUBLIC_URL.replace(/\/$/, '')}/downloads`;
  return backKb([
    [{ text: '🪟 Скачать для Windows', url: `${root}/${DESKTOP_RELEASE.windows}` }],
    [{ text: '🐧 Скачать для Linux x64', url: `${root}/${DESKTOP_RELEASE.linux}` }],
    [{ text: '📱 Скачать APK для Android', url: `${root}/${DESKTOP_RELEASE.android}` }],
    [{ text: '🌐 Версия и инструкция', url: `${PUBLIC_URL}/download` }],
  ]);
}

function copyrightText() {
  return [
    '©️ *Документация авторских прав*',
    '',
    'Исключительное имя сервиса или название зарегистрировано на @fame_miks.',
    '',
    'Любые информационные правки или попытки заполучить название или изменить его не могут быть опровержены или подтверждены.',
    '',
    'С 01.07.2026 это название сервиса является только владением @fame_miks.',
    '',
    'Любые попытки плагиата или изменения никнейма имеют весомость закона и защищены законами стран мира.',
    '',
    'Названия такие как Clop ai нигде до того не были созданы или использованы.',
    '',
    'Исключительный владелец — @fame_miks.',
    '',
    'Попытка нарушения авторских прав несёт за собой ответственность: ст. 146 УК РФ, ст. 198 УК РК (от 10 тыс. до 10 млн руб).',
  ].join('\n');
}

function startText(u) {
  const m = modelOf(u);
  const lines = [
    `👋 Привет! Это *${BOT_NAME}*.`,
    '',
    'Отвечаю на вопросы, пишу и объясняю код, помогаю с текстами и идеями.',
    '',
    `Сейчас: модель *${m.short}*, мышление *${m.supportsEffort === false ? 'своё' : effortOf(u, m).short}*, тариф *${planOf(u).title}*.`,
    // Берём ту, что реально помечена recommended, а не зашитую вручную —
    // иначе при смене модели по умолчанию тут остаётся неправда
    `⭐ Рекомендуемая модель — *${(Object.values(MODELS).find((x) => x.recommended) || MODELS[DEFAULT_MODEL]).title}*.`,
  ];
  if (Date.now() < UPCOMING_RELEASE.at) {
    lines.push('', `🔔 Уже скоро — *${UPCOMING_RELEASE.title}* (${UPCOMING_RELEASE.desc})! Выход: *${dt(UPCOMING_RELEASE.at)}*.`);
  }
  lines.push('', 'Напишите сообщение или выберите пункт меню 👇');
  return lines.join('\n');
}

/* ---------------- legacy ---------------- */

// У старых версий бота была постоянная клавиатура над полем ввода. Код её
// давно не ставит, но Telegram показывает её, пока явно не удалить — сама она
// не исчезает. Убираем разово при первом обращении и запоминаем в профиле,
// чтобы не слать это сообщение каждый раз.
async function clearLegacyKeyboard(u, chatId) {
  if (u.kbCleared) return;
  u.kbCleared = true;
  store.saveSoon();
  try {
    // Убрать клавиатуру можно только отдельным сообщением: remove_keyboard
    // нельзя совместить с inline-кнопками в одном reply_markup
    const m = await tg.sendMessage(chatId, '🧹 Обновляю меню…', { reply_markup: { remove_keyboard: true } });
    // Сообщение служебное — сразу подчищаем, чтобы не мусорить в чате
    if (m?.message_id) await tg.api('deleteMessage', { chat_id: chatId, message_id: m.message_id }).catch(() => {});
  } catch (e) {
    console.warn('[kb] не удалось убрать старую клавиатуру:', e.message);
  }
}

/* ---------------- payments ---------------- */

function activatePurchasedPlan(u, plan, payment) {
  if (corporatePlan(plan.key)) store.grantCorporatePlan(u, plan.key, plan.days, payment);
  else store.grantPlan(u, plan.key, plan.days, payment);
}

async function sendPlanInvoice(u, chatId, planKey) {
  const p = PLANS[planKey] || corporatePlan(planKey);
  if (!p) throw new Error('Тариф временно недоступен');
  const available = store.bonusBalance(u);
  if (available >= p.stars) {
    store.spendBonus(u, p.stars, { reason: `Скидка на ${p.title}`, plan: p.key });
    activatePurchasedPlan(u, p, { stars: 0, bonus: p.stars, source: 'bonus_purchase' });
    await store.save({ strict: true });
    return void await tg.sendMessage(chatId, `🎁 *${p.title} активирован за ${p.stars} бонусов.*\n\nДоступ до ${dt(corporatePlan(p.key) ? store.activeTeamFor(u).until : u.proUntil)}.`, { reply_markup: mainKb(u) });
  }
  const reservation = store.reserveBonus(u, Math.max(0, p.stars - 1), 24 * 60 * 60_000);
  const discount = reservation?.amount || 0;
  const payable = p.stars - discount;
  const description = p.perks?.join('. ') || `Корпоративный доступ до ${p.maxUsers} пользователей. Общий недельный пул и отдельное 5-часовое окно каждого участника.`;
  try {
    await tg.api('sendInvoice', {
      chat_id: chatId,
      title: `${BOT_NAME} ${p.title} — ${p.days} дней`,
      description: description + (discount ? `. Скидка ${discount} ⭐️ за бонусы.` : '.'),
      payload: `plan:${planKey}:${p.days}:${reservation?.id || '-'}:${discount}`,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: `${BOT_NAME} ${p.title}`, amount: payable }],
    });
  } catch (error) {
    if (reservation) store.releaseBonusReservation(u, reservation.id);
    throw error;
  }
}

function bonusText(u) {
  const report = store.bonusReport(u);
  const names = { credit: 'Начисление', debit: 'Скидка', 'limit-reset': 'Сброс лимита' };
  const rows = report.transactions.slice(0, 12).map((entry) => {
    const amount = Number(entry.amount || 0);
    const value = amount > 0 ? `+${amount}` : amount < 0 ? String(amount) : '—';
    return `• ${dt(entry.ts)} · ${names[entry.type] || entry.type} · *${value}*${entry.reason ? ` · ${entry.reason}` : ''}`;
  });
  return [
    '🎁 *Бонусный счёт*', '',
    `Баланс: *${report.balance} бонусов*`,
    '1 бонус = 1 ⭐️ скидки при покупке тарифа.',
    'После оплаченной покупки начисляется 4% от реально уплаченных звёзд.',
    '', '*Последние операции*', rows.length ? rows.join('\n') : 'Операций пока нет.',
  ].join('\n');
}

function bugReportText(u) {
  const recent = support.userTickets(u.id).filter((ticket) => ticket.type === 'bug').slice(0, 5);
  const labels = { open: 'на проверке', accepted: 'принят', rejected: 'отклонён' };
  return [
    '🐞 *Сообщить о баге*', '',
    'Одним сообщением опишите, что не работает, где это произошло и что вы ожидали увидеть.',
    'После отправки владелец увидит ваш ник и описание, затем примет или отклонит баг. За принятый баг может быть выдано вознаграждение.',
    ...(recent.length ? ['', '*Ваши последние сообщения:*', ...recent.map((ticket) => `• №${ticket.id} — ${labels[ticket.status] || ticket.status}${ticket.reward?.label ? ` · ${ticket.reward.label}` : ''}`)] : []),
  ].join('\n');
}

/* ---------------- AI ---------------- */

/* Поддержка 24/7.

   Отдельный разговор с отдельной ролью: агент отвечает только по работе
   сервиса и отказывается быть обычным помощником. Его ответы в лимит тарифа
   не идут — иначе через поддержку открывался бы обход лимитов, — поэтому у
   неё свой почасовой предохранитель. */
function supportText(u) {
  const open = support.userTickets(u.id).filter((t) => t.status !== 'closed');
  const lines = [
    '🛟 *Поддержка Clop ai*',
    '',
    'Задайте вопрос — отвечу про тарифы, лимиты, модели, оплату, сайт и приложение. Разберу проблему с покупкой подписки.',
    'Если нужен человек, оформлю заявку — оператор ответит здесь же.',
    '',
    '_Это линия поддержки: задачи, код и тексты здесь не делают — для этого обычный чат, /start._',
  ];
  if (open.length) {
    lines.push('', '*Ваши открытые заявки:*');
    for (const t of open.slice(0, 5)) {
      lines.push(`• №${t.id} — ${t.subject} (${t.status === 'answered' ? 'есть ответ' : 'в работе'})`);
    }
  }
  return lines.join('\n');
}

function supportKb() {
  return backKb([[{ text: '🚪 Выйти из поддержки', callback_data: 'support_off' }]]);
}

async function handleSupport(u, chatId, text) {
  if (busy.has(u.id)) return void await tg.sendMessage(chatId, '⏳ Дождитесь ответа на предыдущее сообщение.');

  // Свой счётчик: поддержка бесплатна, но не безгранична
  const hour = Date.now() - 3600_000;
  u.supportHits = (u.supportHits || []).filter((ts) => ts > hour);
  if (u.supportHits.length >= support.SUPPORT_HOURLY_LIMIT) {
    return void await tg.sendMessage(chatId, '⏳ Слишком много обращений в поддержку за час. Попробуйте позже — или дождитесь ответа оператора по уже открытой заявке.');
  }
  u.supportHits.push(Date.now());

  let chat = u.supportChatId ? store.getChat(u, u.supportChatId) : null;
  if (!chat) { chat = store.newChat(u, 'Поддержка'); u.supportChatId = chat.id; }
  store.pushMessage(chat, 'user', text);

  busy.add(u.id);
  await tg.typing(chatId);
  try {
    const res = await gptAsk({
      chat: { ...chat, gptThreadId: null }, modelCli: MODELS[support.SUPPORT_MODEL].cli,
      fixedEffort: "low", prompt: support.SUPPORT_PROMPT + "\n\nСообщение пользователя:\n" + text,
    });
    if (!res.ok) {
      return void await tg.sendMessage(chatId, '⚠️ Поддержка сейчас недоступна. Попробуйте через минуту.');
    }
    chat.sessionId = res.sessionId;
    const parsed = support.parseTicket(res.text);
    store.pushMessage(chat, 'assistant', res.text, { model: support.SUPPORT_MODEL });

    let answer = parsed.text || 'Готово.';
    if (parsed.ticket) {
      const t = support.createTicket(u, parsed.ticket.subject, parsed.ticket.body);
      answer += `\n\n📨 Заявка №${t.id} передана оператору — ответ придёт сюда же.`;
      for (const adminId of ADMIN_IDS) {
        tg.sendMessage(adminId, `📨 Новая заявка №${t.id} от ${store.displayName(u)}\n\n*${t.subject}*\n${parsed.ticket.body.slice(0, 500)}`)
          .catch(() => {});
      }
    }
    await store.save();
    await tg.sendMessage(chatId, answer, { reply_markup: supportKb() });
  } catch (e) {
    console.error('[support]', e.message);
    await tg.sendMessage(chatId, '⚠️ Поддержка сейчас недоступна. Попробуйте через минуту.');
  } finally {
    busy.delete(u.id);
  }
}

async function handleAsk(u, chatId, text, images = null) {
  if (support.isMuted(u)) {
    return void await tg.sendMessage(chatId, support.restrictionNote(u));
  }
  if (busy.has(u.id)) {
    await tg.sendMessage(chatId, '⏳ Дождитесь ответа на предыдущее сообщение.');
    return;
  }

  const model = modelOf(u);
  // Проверяем единый лимит всех моделей. Аргумент provider сохранён в API
  // проверки для совместимости, но больше не создаёт отдельный пул.
  const usingOffer = offerActiveFor(u, model.key);
  if (!model.unlimited && !usingOffer) {
    const { blocked } = checkLimits(u, model.provider);
    if (blocked) {
      const plan = planOf(u);
      await tg.sendMessage(chatId, [
        `⛔️ *Общий лимит на ${blocked.title} исчерпан* (100%).`,
        `Обновится через ${humanLeft(blocked.resetAt - Date.now())}.`,
        plan.key === 'free' ? '\n💎 На тарифе Pro лимиты значительно выше.' : '',
      ].filter(Boolean).join('\n'), { reply_markup: plan.key === 'free' ? { inline_keyboard: [[{ text: '💎 Оформить Pro', callback_data: 'plans' }]] } : undefined });
      return;
    }
  }

  if (model.key !== u.model) {
    const was = MODELS[u.model];
    u.model = model.key;
    await tg.sendMessage(chatId, `🔄 ${was ? was.title : 'Выбранная модель'} недоступна на вашем тарифе — переключил на *${model.title}*.`);
  }
  const effort = effortOf(u, model);

  const chat = store.activeChat(u);
  store.pushMessage(chat, 'user', text);

  busy.add(u.id);
  await tg.typing(chatId);

  // Живой плейсхолдер: спиннер, пока модель думает, затем текст растёт по мере генерации
  let msgId = null;
  try {
    const placeholder = await tg.sendMessage(chatId, `🧠 Думаю ${SPIN_FRAMES[0]}`);
    msgId = placeholder?.message_id || null;
  } catch { /* без живого превью — не критично, отправим ответ обычным сообщением в конце */ }

  let frame = 0, lastEdit = 0, lastSent = '', streamedAny = false, editInFlight = false, pendingShown = null;

  const flushEdit = (shown) => {
    if (!msgId) return;
    if (editInFlight) { pendingShown = shown; return; }
    editInFlight = true;
    tg.editMessage(chatId, msgId, shown).finally(() => {
      editInFlight = false;
      if (pendingShown != null) { const next = pendingShown; pendingShown = null; flushEdit(next); }
    });
  };

  const spinTicker = setInterval(() => {
    if (streamedAny || !msgId) return;
    frame = (frame + 1) % SPIN_FRAMES.length;
    flushEdit(`🧠 Думаю ${SPIN_FRAMES[frame]}`);
  }, 700);
  const typingTicker = setInterval(() => tg.typing(chatId), 4500);

  const onDelta = (full) => {
    streamedAny = true;
    if (!msgId) return;
    const now = Date.now();
    if (now - lastEdit < LIVE_EDIT_MIN_MS) return;

    // Если это многофайловый ответ (сайт/проект) — не дампим сырой код в чат,
    // а показываем короткий статус по файлам: что уже готово, что пишется
    let shown;
    FILE_MARK_RE.lastIndex = 0;
    const names = [];
    let mm;
    while ((mm = FILE_MARK_RE.exec(full))) names.push(mm[1].trim().slice(0, 60));

    if (names.length) {
      const closed = (full.match(FILE_END_RE) || []).length;
      const lines = names.map((n, i) => (i < closed ? `✅ ${n}` : `✍️ ${n} — пишу…`));
      shown = `📦 *Собираю проект*\n${lines.join('\n')}`;
    } else {
      let preview = full;
      const capped = preview.length > LIVE_PREVIEW_LIMIT;
      if (capped) preview = preview.slice(0, LIVE_PREVIEW_LIMIT);
      shown = preview + (capped ? '\n\n_…печатает дальше_' : ' ▌');
    }

    if (shown === lastSent) return;
    lastSent = shown;
    lastEdit = now;
    flushEdit(shown);
  };

  const finish = async (finalText) => {
    if (msgId) { try { await tg.editMessage(chatId, msgId, finalText); return; } catch {} }
    await tg.sendMessage(chatId, finalText);
  };

  try {
    const fast = model.provider === 'gpt' && u.fast === true;
    const res = await askModel({ chat, model, effortKey: effort.key, prompt: text, onDelta, images, fast, userId: u.id });
    clearInterval(spinTicker);
    clearInterval(typingTicker);

    if (!res.ok) {
      u.stats.errors += 1;
      store.saveSoon();
      chat.messages.pop();
      await finish(`⚠️ Не получилось получить ответ: \`${res.error}\`\n\nПопробуйте ещё раз.`);
      return;
    }

    if (res.runtime === 'gpt') chat.gptThreadId = res.threadId;
    else chat.sessionId = res.sessionId;
    chat.model = model.key;
    // Текущий размер контекста этого чата — вход+кэш этого хода примерно равен
    // тому, что сейчас реально загружено в окно контекста модели
    chat.contextTokens = res.tokens.input + res.tokens.cacheWrite;
    store.pushMessage(chat, 'assistant', res.text, { tokens: res.tokens.total, model: model.key, effort: effort.key });
    // В быстром режиме GPT списывает на 20% больше. total/costUsd остаются
    // фактическими, а повышающий коэффициент применяется только к лимиту.
    const offerCovered = addOfferUsage(u, model.key, res.tokens.billable);
    const chargeableBillable = Math.max(0, res.tokens.billable - offerCovered);
    const offerBonus = offerCovered > 0 && chargeableBillable === 0;
    const billableForLimit = Math.round(chargeableBillable * (model.limitMultiplier ?? 1) * (fast ? 1.2 : 1));
    store.addUsage(u, {
      ts: Date.now(), chatId: chat.id, model: model.key, effort: effort.key, plan: planOf(u).key,
      input: res.tokens.input, output: res.tokens.output,
      cacheWrite: res.tokens.cacheWrite, cacheRead: res.tokens.cacheRead,
      promptTokens: res.tokens.promptTokens,
      total: res.tokens.total, billable: billableForLimit, costUsd: res.costUsd, durationMs: res.durationMs,
      billingVersion: BILLING_VERSION, offerBonus, offerCovered,
    });
    const after = offerBonus ? [] : checkLimits(u, model.provider).states;
    const warn = after.find((s) => s.percent >= 85);
    let footer = warn ? `\n\n_Общий лимит · ${warn.title}: использовано ${warn.percent}%_` : '';
    // Контекст диалога почти заполнил окно модели — предлагаем сжать
    const ctxPercent = contextPercent(chat, model);
    if (ctxPercent >= 99) {
      footer += `\n\n⚠️ _Контекст чата заполнен на ${ctxPercent}% (лимит модели ${model.title}). Команда /compact очистит его и продолжит с чистого листа._`;
    }

    // Если модель завернула файлы сайта/проекта в маркеры — собираем архив и шлём документом
    const { files, cleanText, truncated } = extractFiles(res.text);
    const cutByLength = res.stopReason === 'max_tokens';
    // Готовый сайт из ответа сразу издаём: пользователю нужна ссылка, а не архив
    let siteLine = '';
    const foundSite = sites.findSite(res.text, files);
    if (foundSite) {
      const pub = await sites.publish(u.id, foundSite, siteQuotaPlan(u));
      if (pub.ok) siteLine = `

🌐 Сайт опубликован — постоянная ссылка: ${pub.url}`;
      else {
        console.warn('[sites]', pub.error);
        siteLine = `\n\n⚠️ ${pub.error}`;
      }
    }
    console.log(`[files] найдено=${files.length} truncated=${truncated || '-'} stopReason=${res.stopReason || '-'}`);

    if (files.length) {
      try {
        const zipBuf = buildZip(files.map((f) => ({ name: f.path, content: f.content })));
        const zipName = `clop-ai-${chat.id}-${Date.now().toString(36)}.zip`;
        const warnLine = (truncated || cutByLength)
          ? `\n\n⚠️ Ответ упёрся в лимит длины — файл «${truncated || '?'}» не дописан и в архив не попал. Попроси продолжить или разбить проект на части.`
          : '';
        await finish((cleanText || `📦 Готово — ${files.length} файл(ов), всё в архиве.`) + siteLine + warnLine + footer);
        await tg.sendDocument(chatId, zipBuf, zipName, { caption: `📦 ${files.length} файл(ов) — распакуйте и открывайте` });
      } catch (e) {
        console.error('[zip]', e.message);
        await tg.sendMessage(chatId, `⚠️ Не удалось собрать архив (${String(e.message).slice(0, 150)}), но вот текст ответа:`);
        await tg.sendMessage(chatId, cleanText || res.text);
      }
    } else if (truncated) {
      // Ни один файл не успел закрыться маркером — архивировать нечего
      await finish(`${cleanText}\n\n⚠️ Ответ обрезан лимитом длины прямо во время написания файла «${truncated}» — ничего не успело завершиться, архив не собран. Попроси то же самое, но короче или по одному файлу за раз.${footer}`.trim());
    } else {
      await finish(res.text + siteLine + footer);
    }
  } catch (e) {
    clearInterval(spinTicker);
    clearInterval(typingTicker);
    u.stats.errors += 1;
    store.saveSoon();
    await finish(`⚠️ Ошибка: ${String(e.message).slice(0, 200)}`);
  } finally {
    clearInterval(spinTicker);
    clearInterval(typingTicker);
    busy.delete(u.id);
  }
}

/* ---------------- routing ---------------- */

async function onCommand(u, chatId, cmd, rawText = '') {
  if (u.pending) { u.pending = null; store.saveSoon(); } // любая команда отменяет ожидание промпта картинки
  if (leaveTransientModes(u, {
    keepSupport: cmd === '/support' || cmd === '/поддержка',
    keepBug: cmd === '/bug' || cmd === '/баг',
  })) store.saveSoon();
  switch (cmd) {
    case '/grant': {
      if (!ADMIN_IDS.includes(String(u.id))) return void await tg.sendMessage(chatId, 'Неизвестная команда. /help — список команд.');
      const parts = rawText.trim().split(/\s+/);
      // /grant @username план_ключ [дней]
      const [, target, planKey, daysStr] = parts;
      const plan = planKey && PLANS[planKey];
      if (!target || !plan) {
        return void await tg.sendMessage(chatId,
          `Формат: \`/grant @username план [дней]\`\nТарифы: ${Object.keys(PLANS).join(', ')}\nПо умолчанию 30 дней.`,
          { parse_mode: 'Markdown' });
      }
      const days = Number(daysStr) > 0 ? Number(daysStr) : 30;
      const target_id = target.replace(/^@/, '');
      const targetUser = /^\d+$/.test(target_id) ? store.findUser(target_id) : store.findUserByUsername(target_id);
      if (!targetUser) return void await tg.sendMessage(chatId, `Пользователь ${target} не найден — он ещё не писал боту.`);
      store.grantPlan(targetUser, planKey, days, { source: 'admin_grant', by: u.id });
      return void await tg.sendMessage(chatId, `✅ ${store.displayName(targetUser)} получил тариф ${plan.title} на ${days} дн.`);
    }
    case '/start':
    case '/menu':
      await clearLegacyKeyboard(u, chatId);
      return void await tg.sendMessage(chatId, startText(u), { reply_markup: mainKb(u) });
    case '/new': {
      const c = store.newChat(u);
      return void await tg.sendMessage(chatId, `💬 Создан новый чат «${c.title}». Контекст очищен.`, { reply_markup: mainKb(u) });
    }
    case '/chats':
      return void await tg.sendMessage(chatId, chatsListText(u), { reply_markup: chatsKb(u) });
    case '/compact':
    case '/сжать': {
      const chat = store.activeChat(u, false);
      if (!chat || !chat.messages.length) return void await tg.sendMessage(chatId, 'Контекст и так пуст — сжимать нечего.');
      const before = contextPercent(chat, modelOf(u));
      compactChat(chat);
      return void await tg.sendMessage(chatId, `🗜 Контекст очищен (было заполнено ~${before}%). Чат тот же, история и лимит тарифа не тронуты — начинаем диалог с чистого листа.`, { reply_markup: mainKb(u) });
    }
    case '/model':
      return void await tg.sendMessage(chatId, modelText(u), { reply_markup: modelKb(u) });
    case '/effort':
      return void await tg.sendMessage(chatId, effortText(u), { reply_markup: effortKb(u) });
    case '/usage':
    case '/limits':
      return void await tg.sendMessage(chatId, usageText(u), { reply_markup: backKb() });
    case '/support':
    case '/поддержка':
      enterSupportMode(u); store.saveSoon();
      return void await tg.sendMessage(chatId, supportText(u), { reply_markup: supportKb() });
    case '/bug':
    case '/баг':
      u.bugReportMode = true; store.saveSoon();
      return void await tg.sendMessage(chatId, bugReportText(u), { reply_markup: backKb() });
    case '/bonus':
    case '/бонусы':
      return void await tg.sendMessage(chatId, bonusText(u), { reply_markup: backKb() });
    case '/devices':
    case '/устройства':
      return void await tg.sendMessage(chatId, devicesText(u), { reply_markup: devicesKb(u) });
    case '/sites':
    case '/сайты':
      return void await tg.sendMessage(chatId, await sitesText(u), { reply_markup: await sitesKb(u) });
    case '/plans':
    case '/pro':
      return void await tg.sendMessage(chatId, plansText(u), { reply_markup: plansKb(u) });
    case '/corporate':
      return void await tg.sendMessage(chatId, corporatePlansText(u), { reply_markup: corporatePlansKb(u) });
    case '/team':
      return void await tg.sendMessage(chatId, teamText(u), { reply_markup: teamKb(u) });
    case '/phone':
      return void await tg.sendMessage(chatId, 'Нажмите кнопку ниже, чтобы сохранить свой Telegram-номер для приглашений в корпоративную команду.', { reply_markup: {
        keyboard: [[{ text: '📱 Поделиться моим номером', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
        input_field_placeholder: 'Поделиться номером',
      } });
    case '/team_add': {
      const identifier = rawText.trim().replace(/^\/\S+\s*/u, '').trim();
      if (!identifier) return void await tg.sendMessage(chatId, 'Укажите username, Telegram ID или сохранённый номер. Например: `/team_add @username`.', { reply_markup: teamKb(u) });
      const target = store.findUserByIdentifier(identifier);
      if (!target) return void await tg.sendMessage(chatId, 'Пользователь не найден. Он должен нажать /start; для поиска по номеру — ещё и один раз использовать /phone.', { reply_markup: teamKb(u) });
      const result = store.inviteToTeam(u, target);
      if (!result.ok) return void await tg.sendMessage(chatId, `⚠️ ${result.error}`, { reply_markup: teamKb(u) });
      try {
        await tg.sendMessage(Number(target.id), [
          '🏢 *Приглашение в корпоративную команду*', '',
          `${store.displayName(u)} приглашает вас в *${corporatePlan(result.team.tier).title}* Clop ai.`,
          'После принятия у вас будут общие корпоративные лимиты команды во всех приложениях Clop.',
        ].join('\n'), { reply_markup: { inline_keyboard: [[
          { text: '✅ Принять', callback_data: 'team_accept:' + result.invite.id },
          { text: '❌ Отказаться', callback_data: 'team_decline:' + result.invite.id },
        ]] } });
      } catch {
        return void await tg.sendMessage(chatId, '⚠️ Telegram не разрешил отправить приглашение. Попросите пользователя снова открыть бота и нажать /start.', { reply_markup: teamKb(u) });
      }
      return void await tg.sendMessage(chatId, `✅ Приглашение отправлено пользователю ${store.displayName(target)}. Место займётся после его согласия.`, { reply_markup: teamKb(u) });
    }
    case '/team_remove': {
      const identifier = rawText.trim().replace(/^\/\S+\s*/u, '').trim();
      const target = store.findUserByIdentifier(identifier);
      if (!identifier || !target) return void await tg.sendMessage(chatId, 'Укажите участника: `/team_remove @username` или его Telegram ID.', { reply_markup: teamKb(u) });
      const result = store.removeTeamMember(u, target.id);
      if (!result.ok) return void await tg.sendMessage(chatId, `⚠️ ${result.error}`, { reply_markup: teamKb(u) });
      await tg.sendMessage(Number(target.id), `ℹ️ ${store.displayName(u)} удалил вас из корпоративной команды Clop ai.`).catch(() => {});
      return void await tg.sendMessage(chatId, `✅ ${store.displayName(target)} удалён из команды.`, { reply_markup: teamKb(u) });
    }
    case '/buy':
      return void await tg.sendMessage(chatId, plansText(u), { reply_markup: plansKb(u) });
    case '/download':
    case '/app':
      return void await tg.sendMessage(chatId, appDownloadText(), { reply_markup: appDownloadKb() });
    case '/image':
    case '/img': {
      const prompt = rawText.trim().replace(/^\/\S+\s*/u, '').trim();
      if (!prompt) {
        return void await tg.sendMessage(chatId, '🖼 Напишите после команды, что создать. Например: `/image рыжий кот-космонавт`.', { reply_markup: mainKb(u) });
      }
      return void await handleImageGen(u, chatId, prompt);
    }
    case '/myapi': {
      // Облачный сервис может спать (бесплатный тариф) — холодный старт до
      // ~50 сек, предупреждаем, чтобы не казалось, что бот завис
      const placeholder = await tg.sendMessage(chatId, '⏳ Получаю ключ… (облачный сервис может «просыпаться» до минуты)');
      const text = await myApiText(u);
      try { await tg.editMessage(chatId, placeholder.message_id, text, { reply_markup: myApiKb() }); }
      catch { await tg.sendMessage(chatId, text, { reply_markup: myApiKb() }); }
      return;
    }
    case '/balance':
    case '/баланс':
      return void await tg.sendMessage(chatId, balanceText(u), { reply_markup: balanceKb() });
    case '/help':
      return void await tg.sendMessage(chatId, helpText(), { reply_markup: helpKb() });
    default:
      return void await tg.sendMessage(chatId, 'Неизвестная команда. /help — список команд.');
  }
}

async function sitesText(u) {
  const list = await sites.listSites(u.id);
  const planKey = siteQuotaPlan(u);
  const limit = sites.siteLimit(planKey);
  const hosting = await sites.hostingState(u.id, planKey);
  const lines = ['🌐 *Мои сайты*', ''];
  lines.push(`Хостинг: *${Math.round(hosting.ramBytes / 1024 / 1024)} МБ RAM* · *${hosting.cpuShare} CPU* · *${Math.round(hosting.storageBytes / 1024 ** 3)} ГБ* хранилища (${hosting.percent}% занято).`, '');
  if (!list.length) {
    lines.push('Пока пусто. Попросите сделать сайт — например «сделай сайт-визитку про кофейню» — и в ответ придёт постоянная ссылка.');
  } else {
    lines.push(`Опубликовано: *${list.length}* из ${limit}. Ссылки постоянные, пока их не удалить.`, '');
    for (const it of list) lines.push(`• [${it.title}](${PUBLIC_URL}/s/${it.slug})`);
  }
  return lines.join('\n');
}

async function sitesKb(u) {
  const list = await sites.listSites(u.id);
  return backKb(list.slice(0, 12).map((it) => [{ text: `🗑 ${it.title}`, callback_data: 'site_del:' + it.slug }]));
}

function devicesText(u) {
  const list = u.devices || [];
  const lines = ['💻 *Подключённые устройства*', ''];
  if (!list.length) {
    lines.push('Пока ни одного. Приложение Clop Code для компьютера подключается так: в нём нажать «Войти через Telegram», бот спросит подтверждение — и всё.');
  } else {
    lines.push('У приложения нет доступа к моделям напрямую — оно ходит через сервер, поэтому расход идёт в ваш общий лимит. Отозвать доступ можно кнопкой ниже: устройство перестанет работать сразу.', '');
    for (const d of list) lines.push(`• *${d.name}* — подключено ${dt(d.ts)}`);
  }
  return lines.join('\n');
}

function devicesKb(u) {
  return backKb((u.devices || []).slice(0, 12).map((d) => [{ text: `🚫 Отключить ${d.name}`, callback_data: 'dev_del:' + d.id }]));
}

function plansKb(u) {
  const currentPlan = planOf(u);
  const cur = currentPlan.corporateKey || currentPlan.key;
  const trial = store.goTrialState(u);
  const trialLabel = trial.eligible
    ? '🎁 Получить пробный GO на 1 день'
    : trial.active
      ? '⚡ Пробный GO уже активен'
      : trial.used
        ? '✓ Пробный GO уже использован'
        : '🎁 Условия пробного GO на 1 день';
  const rows = [[{ text: trialLabel, callback_data: 'trial_go' }]];
  rows.push(...Object.values(PLANS)
    .filter((p) => p.key !== 'free')
    .map((p) => [{
      text: `${cur === p.key ? '🔁 Продлить' : `${p.emoji} Купить`} ${p.title} — ${p.stars} ⭐️`,
      callback_data: 'buy_' + p.key,
    }]));
  if (corporatePlansReady()) rows.push([{ text: '🏢 Корпоративные тарифы', callback_data: 'corporate_plans' }]);
  return backKb(rows);
}

async function sendBalanceInvoice(chatId, stars) {
  const amount = Math.round(Number(stars));
  if (amount < MIN_TOPUP_STARS || amount > MAX_TOPUP_STARS) throw new Error('Пополнение доступно от $1 до $500');
  await tg.api('sendInvoice', {
    chat_id: chatId, title: `Баланс ${BOT_NAME}`, description: `Пополнение API-баланса на $${(amount / STARS_PER_USD).toFixed(2)}.`,
    payload: `balance_${amount}`, provider_token: '', currency: 'XTR', prices: [{ label: 'Баланс API', amount }],
  });
}

function balanceText(u) {
  return [
    '💳 *Баланс API*', '',
    `Доступно: *$${microsToUsd(u.balanceMicros).toFixed(2)}*`,
    `Курс пополнения: *${STARS_PER_USD} ⭐️ = $1*`,
    'Ключ с оплатой по факту не расходует лимиты подписки и оплачивает только успешные ответы.',
    '',
    'Минимум: $1 · максимум: $500 за одно пополнение.',
  ].join('\n');
}

function balanceKb() {
  return backKb([
    [{ text: '$1 · 86 ⭐️', callback_data: 'balance:86' }, { text: '$5 · 430 ⭐️', callback_data: 'balance:430' }],
    [{ text: '$10 · 860 ⭐️', callback_data: 'balance:860' }, { text: '$50 · 4 300 ⭐️', callback_data: 'balance:4300' }],
    [{ text: '$100 · 8 600 ⭐️', callback_data: 'balance:8600' }, { text: '$500 · 43 000 ⭐️', callback_data: 'balance:43000' }],
  ]);
}

function corporatePlansText(u) {
  const active = store.activeTeamFor(u);
  const lines = [
    '🏢 *Корпоративные тарифы*',
    '',
    'У команды общий недельный пул. У каждого участника есть отдельное 5-часовое окно. Остаток виден только в процентах.',
    '',
  ];
  for (const p of Object.values(CORPORATE_PLANS)) {
    lines.push(`${p.emoji} *${p.title}*${active?.tier === p.key ? ' — ваша команда' : ''}`);
    lines.push(`• ${p.stars} ⭐️ / ${p.days} дней`);
    lines.push(`• До ${p.maxUsers} пользователей, включая владельца`);
    lines.push('• Общий расход в боте, сайте, приложении и личном API');
    lines.push('');
  }
  lines.push('_После покупки добавляйте участников командой /team_add. Приглашённый сам принимает или отклоняет приглашение._');
  return lines.join('\n');
}

function teamText(u) {
  const team = store.activeTeamFor(u);
  if (!team) return [
    '🏢 *Моя команда*', '',
    'Активной корпоративной подписки пока нет.',
    'Откройте корпоративные тарифы, выберите подходящий тир и оплатите звёздами Telegram.',
  ].join('\n');
  const plan = corporatePlan(team.tier);
  const owner = store.findUser(team.ownerId);
  const lines = [
    `🏢 *${plan.title}*`,
    `Действует до *${dt(team.until)}*`,
    `Владелец: *${owner ? store.displayName(owner) : 'ID ' + team.ownerId}*`,
    `Участники: *${team.members.length}/${plan.maxUsers}*`,
    '',
  ];
  for (const id of team.members) {
    const member = store.findUser(id);
    lines.push(`• ${id === team.ownerId ? '👑 ' : ''}${member ? store.displayName(member) : 'ID ' + id}`);
  }
  if (team.ownerId === String(u.id)) {
    lines.push('', '*Управление*');
    lines.push('/team_add @username — пригласить по username');
    lines.push('/team_add 123456789 — пригласить по Telegram ID');
    lines.push('/team_add +380… — пригласить по сохранённому номеру');
    lines.push('/team_remove @username — удалить участника');
    lines.push('', 'Пользователь должен заранее нажать /start. Для приглашения по номеру он один раз использует /phone.');
  }
  return lines.join('\n');
}

function teamKb(u) {
  const rows = [[{ text: '🏢 Корпоративные тарифы', callback_data: 'corporate_plans' }]];
  if (store.activeTeamFor(u)?.ownerId === String(u.id)) {
    rows.unshift([{ text: '➕ Как добавить участника', callback_data: 'team_add_help' }]);
  }
  return backKb(rows);
}

function corporatePlansKb(u) {
  const team = store.activeTeamFor(u);
  const rows = Object.values(CORPORATE_PLANS).map((p) => [{
    text: `${team?.tier === p.key ? '🔁 Продлить' : `${p.emoji} Купить`} ${p.title} — ${p.stars} ⭐️`,
    callback_data: 'buy_' + p.key,
  }]);
  rows.push([{ text: '👥 Управление командой', callback_data: 'team' }]);
  return backKb(rows);
}

function modelText(u) {
  const plan = planOf(u);
  const lines = ['🤖 *Выбор модели*', ''];
  for (const m of Object.values(MODELS)) {
    const plans = modelPlans(m);
    const locked = !modelAvailableTo(u, m);
    lines.push(`${m.key === modelOf(u).key ? '✅' : locked ? '🔒' : '▫️'} *${m.title}*${m.recommended ? ' — ⭐ рекомендуется' : ''}`);
    lines.push(`_${m.desc}_`);
    lines.push(`Доступна: ${plans.map((p) => PLANS[p].title).join(', ')}`);
    const rating = modelRatings(m);
    lines.push(`Цена: *${rating.price}/5* · Скорость: *${rating.speed}/5* · Качество: *${rating.quality}/5*`);
    if (m.unlimited) lines.push('🎁 _Навсегда бесплатна — расход не идёт в лимит тарифа_');
    if (modelInPromo(m.key)) lines.push(`🎉 _Акция: открыта всем до ${dt(MODEL_PROMO.until)}_`);
    if (m.key === 'opus-5' && Date.now() < OPUS_FREE_PROMO_UNTIL) {
      lines.push(`🎉 _Акция: временно бесплатно, до ${dt(OPUS_FREE_PROMO_UNTIL)} — лимит тарифа расходуется как обычно_`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function effortText(u) {
  const model = modelOf(u);
  if (model.supportsEffort === false) {
    return [
      '🧠 *Сила мышления*',
      '',
      `У модели *${model.title}* нет регулировки силы мышления — она думает по-своему, встроенно.`,
      'Выбор уровня доступен у GPT-6 Astra — переключитесь на неё в разделе «Модель».',
    ].join('\n');
  }
  const plan = planOf(u);
  const cfg = plan.effort;
  if (cfg.locked) {
    return [
      '🧠 *Сила мышления*',
      '',
      `На тарифе ${plan.emoji} *${plan.title}* сила мышления фиксирована: *${EFFORTS[cfg.fixed].title}*.`,
      `_${EFFORTS[cfg.fixed].desc}_`,
      '',
      '💎 На тарифе Pro можно выбирать любой уровень.',
    ].join('\n');
  }
  const current = effortOf(u, model).key;
  const opts = allowedEffortOptions(u, model);
  const lines = ['🧠 *Сила мышления*', '', `Тариф ${plan.emoji} *${plan.title}* — доступен выбор:`, ''];
  for (const key of opts) {
    const e = EFFORTS[key];
    lines.push(`${key === current ? '✅' : '▫️'} *${e.title}*`);
    lines.push(`_${e.desc}_`);
    lines.push('');
  }
  if (opts.length < cfg.options.length) {
    lines.push(`_У ${model.title} максимум — ${EFFORTS[opts[opts.length - 1]].title}._`);
  }
  return lines.join('\n');
}

function chatsListText(u) {
  const chats = store.liveChats(u);
  if (!chats.length) return '📂 Чатов пока нет. Создайте новый и напишите сообщение.';
  const lines = ['📂 *Мои чаты*', ''];
  for (const c of chats.slice(0, MAX_CHATS)) {
    lines.push(`${c.id === u.activeChatId ? '🟢' : '💬'} *${c.title}*`);
    lines.push(`_${c.messages.length} сообщ. · ${dt(c.updatedAt)} · ${(MODELS[c.model] || {}).short || '—'}_`);
    lines.push('');
  }
  return lines.join('\n');
}

async function onCallback(u, q) {
  const chatId = q.message.chat.id;
  const msgId = q.message.message_id;
  const data = q.data || '';
  const edit = (text, kb) => tg.editMessage(chatId, msgId, text, { reply_markup: kb });

  // Любая кнопка вне самой поддержки/формы бага означает, что пользователь
  // вернулся к обычному боту. Раньше флаг поддержки оставался в профиле и
  // после выбора модели следующее сообщение ошибочно уходило оператору.
  if (leaveTransientModes(u, {
    keepSupport: data === 'support' || data === 'support_off',
    keepBug: data === 'bug_report',
  })) store.saveSoon();

  if (data === 'menu') {
    if (u.pending) { u.pending = null; store.saveSoon(); }
    await tg.answerCallback(q.id);
    return void await edit(startText(u), mainKb(u));
  }
  if (data === 'offer_claim') {
    const offer = claimOffer(u);
    if (!offer) return void await tg.answerCallback(q.id, 'Предложение уже завершилось', true);
    await store.save();
    await tg.answerCallback(q.id, offer.active ? '🎁 Бонус Astra и Kimi K3 подключён на 5 часов' : 'Предложение уже использовано', true);
    return void await edit(offer.active
      ? `🎁 *Предложение подключено*\n\nБонусный доступ к GPT-6 Astra и Kimi K3 активен до ${dt(offer.until)} по Киеву. Остаток показывается только в процентах.`
      : 'Предложение уже завершилось.', mainKb(u));
  }
  if (data === 'usage') { await tg.answerCallback(q.id); return void await edit(usageText(u), backKb()); }
  if (data === 'server_status') {
    await tg.answerCallback(q.id, 'Обновляю показатели…');
    return void await edit(formatServerStatus(await getServerMetrics()), backKb([
      [{ text: '🔄 Обновить', callback_data: 'server_status' }],
    ]));
  }
  if (data === 'app_download') { await tg.answerCallback(q.id); return void await edit(appDownloadText(), appDownloadKb()); }
  if (data === 'help') { await tg.answerCallback(q.id); return void await edit(helpText(), helpKb()); }
  if (data === 'copyright') { await tg.answerCallback(q.id); return void await edit(copyrightText(), backKb([[{ text: '⬅️ Назад к справке', callback_data: 'help' }]])); }
  // Подтверждение подключения приложения: код виден в ссылке, поэтому сам по
  // себе он бесполезен — токен выдаётся только владельцу секрета на том ПК
  if (data.startsWith('desk_ok:')) {
    const ok = desk.claimPair(data.slice(8), u.id);
    if (ok) await store.save();
    await tg.answerCallback(q.id);
    return void await edit(ok
      ? '✅ Приложение подключено — вернитесь в него, вход завершится сам.\n\nЛимиты и модели те же, что здесь. Отключить доступ можно командой /devices.'
      : '⚠️ Код устарел. Нажмите «Войти через Telegram» в приложении ещё раз.', backKb());
  }
  if (data.startsWith('dev_del:')) {
    const gone = desk.removeDevice(u, data.slice(8));
    if (gone) store.saveSoon();
    await tg.answerCallback(q.id, gone ? '🚫 Устройство отключено' : 'Не найдено', !gone);
    return void await edit(devicesText(u), devicesKb(u));
  }
  if (data === 'support') {
    enterSupportMode(u); store.saveSoon();
    await tg.answerCallback(q.id);
    return void await edit(supportText(u), supportKb());
  }
  if (data === 'support_off') {
    leaveSupportMode(u); store.saveSoon();
    await tg.answerCallback(q.id, '🚪 Вышли из поддержки');
    return void await edit(startText(u), mainKb(u));
  }
  if (data === 'devices') { await tg.answerCallback(q.id); return void await edit(devicesText(u), devicesKb(u)); }
  if (data === 'sites') { await tg.answerCallback(q.id); return void await edit(await sitesText(u), await sitesKb(u)); }
  if (data.startsWith('site_del:')) {
    const ok = await sites.removeSite(u.id, data.split(':')[1]);
    await tg.answerCallback(q.id, ok ? '🗑 Сайт удалён, ссылка больше не открывается' : 'Не удалось удалить', !ok);
    return void await edit(await sitesText(u), await sitesKb(u));
  }
  if (data === 'plans') { await tg.answerCallback(q.id); return void await edit(plansText(u), plansKb(u)); }
  if (data === 'trial_go') {
    const trial = store.activateGoTrial(u);
    if (!trial.ok) {
      const message = trial.active
        ? `Пробный GO уже активен до ${dt(trial.endsAt)}.`
        : trial.used
          ? 'Пробный GO уже использован на этом аккаунте.'
          : trial.reason === 'team_subscription'
            ? 'Пробный GO доступен бесплатным аккаунтам без командной подписки.'
            : 'Пробный GO доступен бесплатным аккаунтам без активной подписки.';
      return void await tg.answerCallback(q.id, message, true);
    }
    await store.save({ strict: true });
    await tg.answerCallback(q.id, 'GO активирован на 24 часа');
    return void await edit(`🎁 *Пробный GO активирован до ${dt(trial.endsAt)}.*\n\nДоступ к моделям и лимитам GO уже работает во всех приложениях Clop. После окончания можно купить GO в разделе тарифов.`, plansKb(u));
  }
  if (data === 'corporate_plans') { await tg.answerCallback(q.id); return void await edit(corporatePlansText(u), corporatePlansKb(u)); }
  if (data === 'team') { await tg.answerCallback(q.id); return void await edit(teamText(u), teamKb(u)); }
  if (data === 'team_add_help') {
    await tg.answerCallback(q.id);
    return void await edit('➕ *Добавление участника*\n\nОтправьте отдельным сообщением одну из команд:\n`/team_add @username`\n`/team_add 123456789`\n`/team_add +380…`\n\nПользователь должен заранее нажать /start. Для поиска по номеру он один раз использует команду /phone.', teamKb(u));
  }
  if (data === 'bug_report') {
    u.bugReportMode = true; store.saveSoon();
    await tg.answerCallback(q.id);
    return void await edit(bugReportText(u), backKb());
  }
  if (data === 'bonus') { await tg.answerCallback(q.id); return void await edit(bonusText(u), backKb()); }
  if (data.startsWith('team_accept:') || data.startsWith('team_decline:')) {
    const accept = data.startsWith('team_accept:');
    const inviteId = data.slice(data.indexOf(':') + 1);
    const result = store.respondToTeamInvite(u, inviteId, accept);
    if (!result.ok) return void await tg.answerCallback(q.id, result.error, true);
    await store.save();
    await tg.answerCallback(q.id, accept ? 'Вы присоединились к команде' : 'Приглашение отклонено');
    const owner = store.findUser(result.team.ownerId);
    if (owner) await tg.sendMessage(Number(owner.id), `${accept ? '✅' : '❌'} ${store.displayName(u)} ${accept ? 'принял(а)' : 'отклонил(а)'} приглашение в вашу команду.`).catch(() => {});
    return void await edit(accept ? `✅ Вы присоединились к *${corporatePlan(result.team.tier).title}*. Лимиты и доступ синхронизированы с ботом, сайтом, приложениями и API.` : '❌ Вы отказались от приглашения.', mainKb(u));
  }
  if (data === 'model') { await tg.answerCallback(q.id); return void await edit(modelText(u), modelKb(u)); }
  if (data === 'effort') { await tg.answerCallback(q.id); return void await edit(effortText(u), effortKb(u)); }
  if (data === 'fast_toggle') {
    u.fast = !u.fast;
    store.saveSoon();
    await tg.answerCallback(q.id, `⚡ Быстрый режим ${u.fast ? 'включён' : 'выключен'}`);
    return void await edit(menuText(u), mainKb(u));
  }
  if (data === 'chats') { await tg.answerCallback(q.id); return void await edit(chatsListText(u), chatsKb(u)); }
  if (data === 'imagegen') { await tg.answerCallback(q.id); return void await edit(imageGenText(u), imageGenKb()); }
  if (data.startsWith('imagegen_pick:')) {
    const genKey = data.split(':')[1];
    if (!IMAGE_GENERATORS[genKey]) return void await tg.answerCallback(q.id, 'Генератор не найден');
    if (imageLimitState(u).exceeded) return void await tg.answerCallback(q.id, '⛔️ Дневной лимит исчерпан', true);
    u.pending = { type: 'imagegen', generator: genKey };
    store.saveSoon();
    await tg.answerCallback(q.id);
    return void await edit('🖼 Опишите, что нарисовать (одним сообщением) — я сгенерирую и пришлю картинку.', backKb());
  }
  if (data === 'myapi') {
    await tg.answerCallback(q.id, '⏳ Получаю ключ… облако может «просыпаться» до минуты');
    return void await edit(await myApiText(u), myApiKb());
  }
  if (data === 'myapi_reset') {
    if (!cloudEnabled()) return void await tg.answerCallback(q.id, '⚠️ Облачный API недоступен', true);
    // answerCallback можно вызвать только один раз на запрос — дальше просто
    // редактируем сообщение, статус-тост уже показан
    await tg.answerCallback(q.id, '⏳ Сбрасываю… облако может «просыпаться» до минуты');
    const res = await resetApiKey(u.id, planOf(u).key);
    if (!res || !res.apiKey) return void await edit('⚠️ Не удалось сбросить ключ — облачный сервис недоступен. Попробуйте позже.', myApiKb());
    u.cloudKey = true;
    store.saveSoon();
    return void await edit(apiKeyText({ ...res, wasReset: true }), myApiKb());
  }
  if (data.startsWith('balance:')) {
    const stars = Number(data.split(':')[1]);
    if (!Number.isInteger(stars) || stars < MIN_TOPUP_STARS || stars > MAX_TOPUP_STARS) return void await tg.answerCallback(q.id, 'Неверная сумма', true);
    await tg.answerCallback(q.id);
    return void await sendBalanceInvoice(chatId, stars);
  }
  if (data.startsWith('need_plan:')) {
    const m = MODELS[data.split(':')[1]];
    const plansStr = m ? modelPlans(m).map((p) => PLANS[p].title).join(' / ') : 'Pro';
    return void await tg.answerCallback(q.id, `🔒 ${m ? m.title : 'Модель'} доступна на тарифах: ${plansStr}`, true);
  }

  if (data === 'new_chat') {
    const live = store.liveChats(u);
    if (live.length >= MAX_CHATS) store.deleteChat(u, live[live.length - 1].id);
    const c = store.newChat(u);
    await tg.answerCallback(q.id, '💬 Новый чат создан');
    return void await edit(`💬 Создан новый чат «${c.title}». Пишите сообщение — контекст начнётся с нуля.`, mainKb(u));
  }

  if (data.startsWith('model_set:')) {
    const key = data.split(':')[1];
    const m = MODELS[key];
    if (!m) return void await tg.answerCallback(q.id, 'Модель не найдена');
    if (!modelAvailableTo(u, m)) return void await tg.answerCallback(q.id, '🔒 Модель недоступна на вашем тарифе', true);
    u.model = key;
    store.saveSoon();
    await tg.answerCallback(q.id, `Выбрана ${m.short}`);
    return void await edit(modelText(u), modelKb(u));
  }

  if (data.startsWith('effort_set:')) {
    const key = data.split(':')[1];
    if (!allowedEffortOptions(u, modelOf(u)).includes(key)) return void await tg.answerCallback(q.id, '🔒 Недоступно на текущем тарифе/модели', true);
    u.effort = key;
    store.saveSoon();
    await tg.answerCallback(q.id, `Выбрано: ${EFFORTS[key].short}`);
    return void await edit(effortText(u), effortKb(u));
  }

  if (data.startsWith('chat:')) {
    const c = store.getChat(u, data.slice(5));
    if (!c) return void await tg.answerCallback(q.id, 'Чат не найден');
    u.activeChatId = c.id;
    store.saveSoon();
    await tg.answerCallback(q.id, 'Чат выбран');
    return void await edit(chatsListText(u), chatsKb(u));
  }

  if (data.startsWith('chat_del:')) {
    store.deleteChat(u, data.slice(9));
    await tg.answerCallback(q.id, '🗑 Чат удалён');
    return void await edit(chatsListText(u), chatsKb(u));
  }

  if (data.startsWith('buy_') && (PLANS[data.slice(4)] || corporatePlan(data.slice(4)))) {
    await tg.answerCallback(q.id);
    return void await sendPlanInvoice(u, chatId, data.slice(4));
  }

  await tg.answerCallback(q.id);
}

/* ---------------- files upload ---------------- */

function looksLikeText(buf) {
  // грубая проверка на бинарность: доля непечатных байт в первых 2000
  const sample = buf.subarray(0, 2000);
  let bad = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) bad++;
  }
  return bad / Math.max(1, sample.length) < 0.05;
}

/* Фотографии. Telegram присылает несколько размеров одного снимка —
   берём самый крупный: мелкие модель просто не разберёт. */
async function handlePhoto(u, chatId, msg) {
  if (busy.has(u.id)) {
    return void await tg.sendMessage(chatId, '⏳ Дождитесь ответа на предыдущее сообщение.');
  }
  const sizes = msg.photo || [];
  const best = sizes[sizes.length - 1];
  if (!best) return void await tg.sendMessage(chatId, '🙂 Не получилось разобрать снимок.');

  await tg.typing(chatId);
  let buf;
  try {
    const info = await tg.getFile(best.file_id);
    buf = await tg.downloadFile(info.file_path);
  } catch (e) {
    return void await tg.sendMessage(chatId, `⚠️ Не удалось скачать фото: ${String(e.message).slice(0, 150)}`);
  }
  await sendWithImages(u, chatId, [buf], (msg.caption || '').trim()
    || 'Опиши, что на изображении, и ответь по его содержимому.');
}

// Общий путь для фото и картинок-документов: положить на диск, спросить
// модель, прибрать за собой в любом случае
async function sendWithImages(u, chatId, buffers, prompt) {
  const images = vision.stash(buffers);
  if (!images) {
    return void await tg.sendMessage(chatId, '🙂 Не удалось разобрать изображение — попробуйте png или jpg.');
  }
  try {
    await handleAsk(u, chatId, prompt, images);
  } finally {
    vision.drop(images.dir);
    vision.sweep();
  }
}

async function handleDocument(u, chatId, msg) {
  if (busy.has(u.id)) {
    return void await tg.sendMessage(chatId, '⏳ Дождитесь ответа на предыдущее сообщение.');
  }
  const doc = msg.document;
  const name = doc.file_name || 'file';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const mime = doc.mime_type || '';
  const looksText = TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/') || mime === 'application/json';

  // Картинку могли прислать файлом, без сжатия — это тоже изображение
  if (vision.isImage(name, mime)) {
    if (doc.file_size && doc.file_size > vision.MAX_IMAGE_BYTES) {
      return void await tg.sendMessage(chatId, `🖼 «${name}» слишком большой — лимит ${vision.MAX_IMAGE_BYTES / 1024 / 1024} МБ.`);
    }
    await tg.typing(chatId);
    try {
      const info = await tg.getFile(doc.file_id);
      const buf = await tg.downloadFile(info.file_path);
      return void await sendWithImages(u, chatId, [buf], (msg.caption || '').trim()
        || 'Опиши, что на изображении, и ответь по его содержимому.');
    } catch (e) {
      return void await tg.sendMessage(chatId, `⚠️ Не удалось скачать файл: ${String(e.message).slice(0, 150)}`);
    }
  }

  // Документы Microsoft 365 — zip с XML внутри, текст достаём сами
  if (isOffice(name, mime)) {
    if (doc.file_size && doc.file_size > MAX_DOC_BYTES) {
      return void await tg.sendMessage(chatId, `📎 «${name}» слишком большой (${(doc.file_size / 1024 / 1024).toFixed(1)} МБ) — лимит ${MAX_DOC_BYTES / 1024 / 1024} МБ.`);
    }
    await tg.typing(chatId);
    let buf;
    try {
      const info = await tg.getFile(doc.file_id);
      buf = await tg.downloadFile(info.file_path);
    } catch (e) {
      return void await tg.sendMessage(chatId, `⚠️ Не удалось скачать файл: ${String(e.message).slice(0, 150)}`);
    }
    const r = extractOffice(buf, name);
    if (!r.ok) {
      const старый = /^(doc|xls|ppt)$/.test(ext);
      return void await tg.sendMessage(chatId, `📎 «${name}» — ${r.error}.` + (старый
        ? ' Это старый формат Office. Пересохраните как .docx, .xlsx или .pptx — их читаю.'
        : ''));
    }
    let content = r.text;
    let note = '';
    if (content.length > MAX_DOC_CHARS) {
      content = content.slice(0, MAX_DOC_CHARS);
      note = `\n\n[документ обрезан, показаны первые ${MAX_DOC_CHARS.toLocaleString('ru-RU')} символов]`;
    }
    const caption = (msg.caption || '').trim();
    return void await handleAsk(u, chatId, [
      `Пользователь прислал документ «${name}», вот его текст:`,
      '---', content + note, '---',
      caption || 'Прокомментируй документ: о чём он и что важное внутри.',
    ].join('\n'));
  }

  if (!looksText) {
    return void await tg.sendMessage(chatId, `📎 «${name}» — не похоже на файл, который я понимаю (${mime || 'неизвестный тип'}). Умею: текст и код, картинки (png, jpg, webp), документы Word, Excel и PowerPoint.`);
  }
  if (doc.file_size && doc.file_size > MAX_DOC_BYTES) {
    return void await tg.sendMessage(chatId, `📎 «${name}» слишком большой (${(doc.file_size / 1024 / 1024).toFixed(1)} МБ) — лимит ${MAX_DOC_BYTES / 1024 / 1024} МБ.`);
  }

  await tg.typing(chatId);
  let buf;
  try {
    const info = await tg.getFile(doc.file_id);
    buf = await tg.downloadFile(info.file_path);
  } catch (e) {
    return void await tg.sendMessage(chatId, `⚠️ Не удалось скачать файл: ${String(e.message).slice(0, 150)}`);
  }

  if (!looksLikeText(buf)) {
    return void await tg.sendMessage(chatId, `📎 «${name}» открылся как бинарный файл — не могу прочитать содержимое как текст.`);
  }

  let content = buf.toString('utf8');
  let truncNote = '';
  if (content.length > MAX_DOC_CHARS) {
    content = content.slice(0, MAX_DOC_CHARS);
    truncNote = `\n\n[файл обрезан, показаны первые ${MAX_DOC_CHARS.toLocaleString('ru-RU')} символов]`;
  }

  const caption = (msg.caption || '').trim();
  const prompt = [
    `Пользователь прислал файл «${name}»:`,
    '---',
    content + truncNote,
    '---',
    caption || 'Прокомментируй файл: что это и как выглядит по содержанию.',
  ].join('\n');

  await handleAsk(u, chatId, prompt);
}

async function persistImageJob(u, job) {
  u.imageJob = job;
  await store.save({ strict: true });
}

async function clearImageJob(u) {
  delete u.imageJob;
  await store.save({ strict: true });
}

async function imageFailureMessage(u, chatId, placeholder, text) {
  if (placeholder?.message_id) {
    const edited = await tg.editMessage(chatId, placeholder.message_id, text);
    if (edited) return;
  }
  await tg.sendMessage(chatId, text, { reply_markup: mainKb(u) });
}

async function handleImageGen(u, chatId, prompt, { recoveryJob = null } = {}) {
  if (busy.has(u.id)) return void await tg.sendMessage(chatId, '⏳ Дождитесь предыдущего ответа.');
  const lim = imageLimitState(u);
  if (lim.exceeded) {
    u.pending = null; store.saveSoon();
    return void await tg.sendMessage(chatId, '⛔️ Дневной лимит генераций картинок исчерпан на сегодня.', { reply_markup: mainKb(u) });
  }
  u.pending = null;
  store.saveSoon();
  busy.add(u.id);
  let placeholder = null;
  try {
    if (recoveryJob) {
      const existingId = Number(recoveryJob.placeholderMessageId) || null;
      if (existingId) {
        const edited = await tg.editMessage(chatId, existingId, '🔄 Сервер перезапустился. Автоматически продолжаю генерацию…');
        if (edited) placeholder = { message_id: existingId };
      }
      if (!placeholder) placeholder = await tg.sendMessage(chatId, '🔄 Продолжаю генерацию после перезапуска сервера…');
      const retried = prepareImageJobRetry({ ...recoveryJob, placeholderMessageId: placeholder?.message_id || existingId });
      await persistImageJob(u, retried);
    } else {
      try { placeholder = await tg.sendMessage(chatId, '🖼 Генерирую… это может занять минуту-две (бета)'); } catch {}
      await persistImageJob(u, createImageJob({ chatId, prompt, placeholderMessageId: placeholder?.message_id }));
    }

    const res = await generateImage(prompt);
    if (!res.ok) {
      u.stats.errors += 1;
      await clearImageJob(u);
      const errText = `⚠️ Не удалось сгенерировать: \`${res.error}\``;
      return void await imageFailureMessage(u, chatId, placeholder, errText);
    }

    await persistImageJob(u, { ...u.imageJob, stage: 'sending' });
    await tg.sendPhoto(chatId, res.buffer, 'image.png', { caption: `🖼 ${prompt}`.slice(0, 1000) });
    store.addImageGeneration(u);
    await clearImageJob(u);
    if (placeholder) { try { await tg.deleteMessage(chatId, placeholder.message_id); } catch {} }
  } catch (e) {
    console.error('[imagegen]', e.message);
    u.stats.errors += 1;
    try { await clearImageJob(u); } catch {}
    await imageFailureMessage(u, chatId, placeholder, `⚠️ Ошибка генерации: ${String(e.message).slice(0, 200)}`);
  } finally {
    busy.delete(u.id);
  }
}

export async function recoverInterruptedImageJobs() {
  const users = store.allUsers().filter((u) => u.imageJob);
  if (!users.length) return;
  console.log(`[imagegen] найдено незавершённых задач: ${users.length}`);

  for (const u of users) {
    const job = u.imageJob;
    const action = imageJobRecoveryAction(job);
    if (action === 'retry') {
      await handleImageGen(u, Number(job.chatId), job.prompt, { recoveryJob: job });
      continue;
    }

    try { await clearImageJob(u); } catch {}
    if (action === 'notify') {
      const chatId = Number(job.chatId);
      const text = '⚠️ Генерация прервалась из-за перезапуска сервера. Неудачная попытка не потратила лимит; повторите запрос.';
      if (job.placeholderMessageId) {
        const edited = await tg.editMessage(chatId, job.placeholderMessageId, text);
        if (edited) continue;
      }
      try { await tg.sendMessage(chatId, text, { reply_markup: mainKb(u) }); } catch (e) {
        console.error('[imagegen] не удалось уведомить после перезапуска:', e.message);
      }
    }
  }
}

export async function handleUpdate(update) {
  if (update.pre_checkout_query) {
    return void await tg.api('answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
  }

  if (update.callback_query) {
    const q = update.callback_query;
    const u = store.getUser(q.from);
    try { return void await onCallback(u, q); }
    catch (e) { console.error('[cb]', e.message); return void await tg.answerCallback(q.id, 'Ошибка, попробуйте ещё раз'); }
  }

  const msg = update.message;
  if (!msg || !msg.from || msg.from.is_bot) return;
  const u = store.getUser(msg.from);
  const chatId = msg.chat.id;

  if (support.isBanned(u)) {
    return void await tg.sendMessage(chatId, support.restrictionNote(u));
  }

  // Одноразово подчищаем клавиатуру от старых версий — не все жмут /start
  if (!u.kbCleared) await clearLegacyKeyboard(u, chatId);

  if (msg.successful_payment) {
    const sp = msg.successful_payment;
    if (String(sp.invoice_payload || '').startsWith('balance_')) {
      const stars = Number(String(sp.invoice_payload).split('_')[1]);
      if (!Number.isInteger(stars) || stars < MIN_TOPUP_STARS || stars > MAX_TOPUP_STARS || sp.total_amount !== stars) return;
      const balance = store.addBalance(u, starsToMicros(stars), { stars, currency: sp.currency, chargeId: sp.telegram_payment_charge_id });
      const earned = purchaseBonus(stars);
      if (earned) store.addBonus(u, earned, { reason: '4% за пополнение API', sourceId: `cashback:${sp.telegram_payment_charge_id}` });
      await store.save();
      return void await tg.sendMessage(chatId, `✅ Баланс пополнен. Доступно: *$${microsToUsd(balance).toFixed(2)}*.${earned ? ` Начислено *${earned} бонусов*.` : ''}\nКлючи с оплатой по факту теперь могут использовать все модели.`);
    }
    const modern = String(sp.invoice_payload || '').match(/^plan:([a-z0-9]+):(\d+):([^:]+):(\d+)$/i);
    const requestedKey = modern ? modern[1] : sp.invoice_payload?.split('_')[0];
    const plan = PLANS[requestedKey] || corporatePlan(requestedKey) || PLANS.pro;
    const planKey = plan.key;
    const reservedBonus = modern ? Number(modern[4]) || 0 : 0;
    if (modern && modern[3] !== '-') {
      const consumed = store.consumeBonusReservation(u, modern[3], { reason: `Скидка на ${plan.title}`, plan: planKey });
      if (consumed === null && reservedBonus) store.spendBonus(u, Math.min(reservedBonus, store.bonusBalance(u)), { reason: `Скидка на ${plan.title}`, plan: planKey });
    }
    const earned = purchaseBonus(sp.total_amount);
    if (earned) store.addBonus(u, earned, { reason: `4% за покупку ${plan.title}`, sourceId: `cashback:${sp.telegram_payment_charge_id}` });
    const payment = {
      stars: sp.total_amount, currency: sp.currency, payload: sp.invoice_payload,
      chargeId: sp.telegram_payment_charge_id,
    };
    activatePurchasedPlan(u, plan, { ...payment, bonus: reservedBonus });
    return void await tg.sendMessage(chatId, [
      `🎉 *Оплата прошла. ${plan.title} активирован!*`,
      '',
      `Доступ до ${dt(corporatePlan(planKey) ? store.activeTeamFor(u).until : u.proUntil)}.`,
      corporatePlan(planKey) ? 'Управление участниками: /team' : `Теперь доступны: ${plan.perks[0]}.`,
      earned ? `Начислено *${earned} бонусов* (4% от оплаты). Баланс: *${store.bonusBalance(u)}*.` : '',
    ].join('\n'), { reply_markup: mainKb(u) });
  }

  if (msg.document) {
    return void await handleDocument(u, chatId, msg);
  }
  if (msg.photo) {
    return void await handlePhoto(u, chatId, msg);
  }
  if (msg.video || msg.voice || msg.audio || msg.sticker) {
    return void await tg.sendMessage(chatId, '🙂 Понимаю текст, картинки и документы Word, Excel, PowerPoint. Видео и голосовые — пока нет.');
  }

  const text = (msg.text || msg.caption || '').trim();
  if (msg.contact) {
    if (String(msg.contact.user_id || '') !== String(u.id)) return void await tg.sendMessage(chatId, 'Отправьте именно свой контакт, чтобы сохранить ваш номер для приглашений в команду.');
    const ok = store.savePhone(u, msg.contact.phone_number);
    return void await tg.sendMessage(chatId, ok ? '✅ Номер сохранён. Теперь владелец корпоративной команды может найти вас по этому номеру.' : '⚠️ Не удалось распознать номер.', { reply_markup: { remove_keyboard: true } });
  }
  if (!text) {
    return void await tg.sendMessage(chatId, 'Пока понимаю только текст 🙂');
  }
  // В режиме поддержки обычный текст уходит оператору, а не моделям. Команды
  // по-прежнему работают: иначе из режима было бы не выйти.
  if (u.bugReportMode && !text.startsWith('/')) {
    try {
      const ticket = support.createBugReport(u, text, 'Telegram');
      u.bugReportMode = false;
      await store.save({ strict: true });
      for (const adminId of ADMIN_IDS) {
        tg.sendMessage(adminId, `🐞 Новый баг №${ticket.id} от ${store.displayName(u)}${u.username ? ` (@${u.username})` : ''}\n\n${text.slice(0, 900)}`).catch(() => {});
      }
      return void await tg.sendMessage(chatId, `✅ Баг №${ticket.id} отправлен. Решение появится в /bug, а уведомление придёт сюда.`, { reply_markup: mainKb(u) });
    } catch (error) {
      return void await tg.sendMessage(chatId, `⚠️ ${error.message}`);
    }
  }
  const hadSupportMode = Boolean(u.supportMode);
  const supportActive = isSupportModeActive(u);
  if (hadSupportMode && !supportActive) store.saveSoon();
  if (supportActive && !text.startsWith('/')) {
    return void await handleSupport(u, chatId, text);
  }
  if (text.startsWith('/')) {
    if (/^\/start(?:\s|$)/i.test(text)) store.markStarted(u);
    // Вход на сайт-чат через Telegram: диплинк t.me/bot?start=weblogin_<code> —
    // привязываем код к этому аккаунту, сайт по коду откроет ту же сессию
    // (тот же store.js, те же лимиты — не отдельный аккаунт).
    const weblogin = text.match(/^\/start\s+weblogin_([a-f0-9]{32})$/);
    if (weblogin) {
      const ok = claimCode(weblogin[1], u.id);
      return void await tg.sendMessage(chatId, ok
        ? '✅ Вход подтверждён — вернитесь на сайт, он подключится автоматически.\n\nЛимиты и модели те же, что и здесь, в боте.'
        : '⚠️ Код для входа устарел или неверен — вернитесь на сайт и попробуйте войти заново.');
    }

    // Подключение приложения для компьютера: t.me/bot?start=desk_<код>.
    // Просто так код не сработает — подтверждение спрашиваем явно.
    const deskLink = text.match(/^\/start\s+desk_([a-z0-9]{10,32})$/i);
    if (deskLink) {
      const info = desk.pairInfo(deskLink[1]);
      if (!info) {
        return void await tg.sendMessage(chatId, '⚠️ Код устарел. Нажмите «Войти через Telegram» в приложении ещё раз.');
      }
      return void await tg.sendMessage(chatId,
        `💻 *Подключить приложение?*\n\nУстройство: *${info.device}*\n\nПосле подтверждения приложение сможет обращаться к моделям от вашего имени — расход пойдёт в ваш общий лимит. Ключей от моделей оно не получает. Отключить доступ можно в любой момент командой /devices.`,
        { reply_markup: { inline_keyboard: [[{ text: '✅ Подключить', callback_data: 'desk_ok:' + deskLink[1] }], [{ text: '❌ Отмена', callback_data: 'menu' }]] } });
    }

    // Покупка тарифа с сайта: диплинк t.me/bot?start=buy_<план> — сразу
    // выставляем счёт в звёздах, оплата проходит обычным путём Telegram.
    const buy = text.match(/^\/start\s+buy_([a-z0-9]+)$/i);
    if (buy) {
      const planKey = buy[1].toLowerCase();
      const plan = PLANS[planKey] || corporatePlan(planKey);
      if (!plan || !plan.stars) {
        return void await tg.sendMessage(chatId, '⚠️ Такой тариф не найден. Смотрите /plans.', { reply_markup: mainKb(u) });
      }
      await tg.sendMessage(chatId, `💎 Оформляем *${plan.title}* на ${plan.days} дней — счёт ниже.`);
      return void await sendPlanInvoice(u, chatId, planKey);
    }

    const balance = text.match(/^\/start\s+balance_(\d+)$/i);
    if (balance) {
      const stars = Number(balance[1]);
      if (stars < MIN_TOPUP_STARS || stars > MAX_TOPUP_STARS) return void await tg.sendMessage(chatId, 'Пополнение доступно от $1 до $500.');
      return void await sendBalanceInvoice(chatId, stars);
    }

    return void await onCommand(u, chatId, text.split(/[\s@]/)[0].toLowerCase(), text);
  }
  if (u.pending?.type === 'imagegen') {
    return void await handleImageGen(u, chatId, text);
  }
  if (wantsGeneratedImage(text)) {
    return void await handleImageGen(u, chatId, text);
  }
  await handleAsk(u, chatId, text);
}
