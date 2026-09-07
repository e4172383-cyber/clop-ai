import crypto from 'node:crypto';
import { PUBLIC_URL } from './config.js';
import * as store from './store.js';
import { proxyApiRequest } from './cloud.js';

export const BOT_TEMPLATES = Object.freeze([
  { id: 'assistant', title: 'Личный помощник', icon: '✦', description: 'Отвечает на вопросы, объясняет и помогает с повседневными задачами.', system: 'Ты полезный личный помощник. Отвечай ясно, дружелюбно и по делу.' },
  { id: 'support', title: 'Поддержка', icon: '◉', description: 'Консультирует клиентов по продукту и передаёт сложные вопросы оператору.', system: 'Ты специалист поддержки. Уточняй проблему, давай пошаговое решение и не выдумывай условия компании.' },
  { id: 'sales', title: 'Продажи', icon: '◆', description: 'Рассказывает об услугах, показывает цены и помогает выбрать предложение.', system: 'Ты консультант по продажам. Помогай выбрать подходящий вариант без давления и используй только переданные цены.' },
  { id: 'code', title: 'Технический бот', icon: '</>', description: 'Разбирает код, ошибки и технические вопросы.', system: 'Ты технический помощник. Давай точные решения, короткие примеры и явно отмечай предположения.' },
]);

const MAX_BOTS_PER_USER = 8;
const secretSeed = process.env.CUSTOM_BOT_SECRET || process.env.CLOUD_INTERNAL_SECRET || process.env.INTERNAL_SECRET || 'clop-local-custom-bots';
const cipherKey = crypto.createHash('sha256').update(secretSeed).digest();

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cipherKey, iv);
  const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

function decrypt(value) {
  const [iv, tag, body] = String(value || '').split('.');
  if (!iv || !tag || !body) throw new Error('secret is unavailable');
  const decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

function botsDb() {
  const db = store.raw();
  if (!db.customBots) db.customBots = {};
  return db.customBots;
}

function templateOf(id) {
  return BOT_TEMPLATES.find((item) => item.id === id) || BOT_TEMPLATES[0];
}

function publicBot(bot) {
  return {
    id: bot.id,
    title: bot.title,
    username: bot.username,
    template: bot.template,
    model: bot.model,
    apiMode: bot.apiMode,
    enabled: bot.enabled !== false,
    createdAt: bot.createdAt,
    lastMessageAt: bot.lastMessageAt || 0,
    requests: bot.requests || 0,
    lastError: bot.lastError || '',
    welcomeText: bot.welcomeText || '',
    pricesText: bot.pricesText || '',
    systemPrompt: bot.systemPrompt || '',
    businessMode: bot.businessMode || 'off',
    businessConnected: Boolean(bot.businessConnectionId && bot.businessEnabled !== false),
    businessAccountName: bot.businessAccountName || '',
  };
}

async function telegram(token, method, body = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) throw new Error(data?.description || `Telegram ${response.status}`);
    return data.result;
  } finally { clearTimeout(timer); }
}

export function listCustomBots(ownerId) {
  return Object.values(botsDb())
    .filter((bot) => bot.ownerId === String(ownerId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicBot);
}

export async function createCustomBot({ ownerId, token, template, title, model, apiMode, apiKey, ownBaseUrl, systemPrompt, welcomeText, pricesText, businessMode }) {
  const ownerBots = listCustomBots(ownerId);
  if (ownerBots.length >= MAX_BOTS_PER_USER) throw new Error(`Можно создать не больше ${MAX_BOTS_PER_USER} ботов.`);
  const cleanToken = String(token || '').trim();
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(cleanToken)) throw new Error('Неверный формат токена Telegram-бота.');
  const me = await telegram(cleanToken, 'getMe');
  if (!me?.username) throw new Error('Telegram не вернул имя бота.');
  if (Object.values(botsDb()).some((bot) => bot.username?.toLowerCase() === me.username.toLowerCase())) throw new Error('Этот Telegram-бот уже подключён.');

  const preset = templateOf(template);
  const id = 'b' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const hookSecret = crypto.randomBytes(24).toString('base64url');
  const mode = apiMode === 'own' ? 'own' : apiMode === 'payg' ? 'payg' : 'subscription';
  const baseUrl = mode === 'own' ? String(ownBaseUrl || '').replace(/\/+$/, '') : '';
  if (mode === 'own' && !/^https:\/\//i.test(baseUrl)) throw new Error('Для своего API укажите адрес, начинающийся с https://');
  if (!apiKey) throw new Error('Ключ API не создан или не указан.');

  const bot = {
    id, ownerId: String(ownerId), title: String(title || me.first_name || preset.title).slice(0, 64),
    username: me.username, template: preset.id, model: String(model || 'gpt-luna').slice(0, 80), apiMode: mode,
    managedApiKey: mode !== 'own',
    ownBaseUrl: baseUrl, token: encrypt(cleanToken), apiKey: encrypt(apiKey), hookSecret,
    systemPrompt: String(systemPrompt || preset.system).slice(0, 8000),
    welcomeText: String(welcomeText || `Привет! Я ${me.first_name || preset.title}. Напишите сообщение — я отвечу с помощью ИИ.`).slice(0, 3500),
    pricesText: String(pricesText || 'Актуальные цены уточните у владельца бота.').slice(0, 3500),
    businessMode: ['auto', 'draft'].includes(businessMode) ? businessMode : 'off',
    enabled: true, createdAt: Date.now(), requests: 0, dialogues: {},
  };
  botsDb()[id] = bot;
  try {
    await telegram(cleanToken, 'setWebhook', {
      url: `${PUBLIC_URL}/custom-bot/${id}/${hookSecret}`,
      secret_token: hookSecret,
      allowed_updates: ['message', 'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'],
      drop_pending_updates: true,
    });
    await telegram(cleanToken, 'setMyCommands', { commands: [
      { command: 'start', description: 'Начать диалог' },
      { command: 'prices', description: 'Цены и условия' },
      { command: 'clear', description: 'Очистить контекст' },
    ] });
    await store.save({ strict: true });
    return publicBot(bot);
  } catch (error) {
    delete botsDb()[id];
    throw error;
  }
}

export async function deleteCustomBot(ownerId, id) {
  const bot = botsDb()[String(id)];
  if (!bot || bot.ownerId !== String(ownerId)) return null;
  try { await telegram(decrypt(bot.token), 'deleteWebhook', { drop_pending_updates: true }); } catch { /* удаляем даже если Telegram временно недоступен */ }
  const plainApiKey = bot.managedApiKey ? decrypt(bot.apiKey) : '';
  delete botsDb()[bot.id];
  await store.save({ strict: true });
  return { ...bot, plainApiKey };
}

async function sendText(token, chatId, text, businessConnectionId = '') {
  const chunks = String(text || '').match(/[\s\S]{1,3900}/g) || ['Не удалось получить ответ.'];
  for (const chunk of chunks) await telegram(token, 'sendMessage', {
    chat_id: chatId, text: chunk,
    ...(businessConnectionId ? { business_connection_id: businessConnectionId } : {}),
    link_preview_options: { is_disabled: true },
  });
}

export async function handleCustomBotWebhook(id, secret, headerSecret, update) {
  const bot = botsDb()[String(id)];
  if (!bot || bot.enabled === false || bot.hookSecret !== String(secret) || (headerSecret && headerSecret !== bot.hookSecret)) return false;
  const updateId = Number(update?.update_id);
  if (Number.isFinite(updateId)) {
    if (Array.isArray(bot.seenUpdates) && bot.seenUpdates.includes(updateId)) return true;
    bot.seenUpdates = [...(bot.seenUpdates || []).slice(-99), updateId];
    store.saveSoon();
  }
  const connection = update?.business_connection;
  if (connection) {
    if (String(connection.user?.id || '') === bot.ownerId) {
      bot.businessConnectionId = String(connection.id || '');
      bot.businessEnabled = connection.is_enabled !== false;
      bot.businessAccountName = [connection.user?.first_name, connection.user?.last_name].filter(Boolean).join(' ');
      bot.businessRights = connection.rights || null;
      store.saveSoon();
    }
    return true;
  }
  if (update?.edited_business_message || update?.deleted_business_messages) return true;
  const isBusiness = Boolean(update?.business_message);
  const message = update?.business_message || update?.message;
  const chatId = message?.chat?.id;
  const text = String(message?.text || message?.caption || '').trim();
  if (!chatId || !text) return true;
  const token = decrypt(bot.token);
  if (isBusiness) {
    if (bot.businessMode === 'off') return true;
    if (String(message.business_connection_id || '') !== String(bot.businessConnectionId || '')) return true;
    if (String(message.from?.id || '') === bot.ownerId || message.sender_business_bot) return true;
  }
  if (/^\/start(?:\s|$)/i.test(text)) { await sendText(token, chatId, bot.welcomeText); return true; }
  if (/^\/prices(?:\s|$)/i.test(text)) { await sendText(token, chatId, bot.pricesText); return true; }
  if (/^\/clear(?:\s|$)/i.test(text)) { delete bot.dialogues[String(chatId)]; store.saveSoon(); await sendText(token, chatId, 'Контекст очищен. Можно начать новую тему.'); return true; }

  await telegram(token, 'sendChatAction', { chat_id: chatId, action: 'typing', ...(isBusiness ? { business_connection_id: bot.businessConnectionId } : {}) }).catch(() => {});
  const dialogueKey = `${isBusiness ? 'business' : 'bot'}:${chatId}`;
  const history = Array.isArray(bot.dialogues[dialogueKey]) ? bot.dialogues[dialogueKey].slice(-10) : [];
  const payload = { model: bot.model, messages: [{ role: 'system', content: bot.systemPrompt }, ...history, { role: 'user', content: text }] };
  let result;
  try {
    if (bot.apiMode === 'own') {
      const response = await fetch(`${bot.ownBaseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${decrypt(bot.apiKey)}` }, body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || body?.error || `API ${response.status}`);
      result = body;
    } else {
      const response = await proxyApiRequest({ path: '/v1/chat/completions', apiKey: decrypt(bot.apiKey), body: payload, authHeader: 'bearer' });
      const parsed = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
      if (!response.ok || response.status >= 400) throw new Error(response.error || parsed?.error?.message || parsed?.error || `API ${response.status}`);
      result = parsed;
    }
    const answer = String(result?.choices?.[0]?.message?.content || result?.output_text || '').trim();
    if (!answer) throw new Error('Модель вернула пустой ответ');
    bot.dialogues[dialogueKey] = [...history, { role: 'user', content: text.slice(0, 8000) }, { role: 'assistant', content: answer.slice(0, 12000) }].slice(-12);
    bot.lastMessageAt = Date.now(); bot.requests = Number(bot.requests || 0) + 1; bot.lastError = '';
    store.saveSoon();
    if (isBusiness && bot.businessMode === 'draft') {
      const customer = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || `чат ${chatId}`;
      await sendText(token, bot.ownerId, `Черновик ответа для ${customer}:\n\n${answer}`);
    } else {
      await sendText(token, chatId, answer, isBusiness ? bot.businessConnectionId : '');
    }
  } catch (error) {
    bot.lastError = String(error.message || error).slice(0, 300); bot.lastMessageAt = Date.now(); store.saveSoon();
    if (!isBusiness) await sendText(token, chatId, `Сейчас не удалось получить ответ: ${bot.lastError}`);
  }
  return true;
}
