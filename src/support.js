import * as store from './store.js';

/* Поддержка 24/7.

   Отвечает отдельный агент на GPT Луна. Он именно поддержка, а не
   помощник: писать код, сочинять тексты и решать задачи пользователя он
   отказывается — иначе через «поддержку» открылся бы обход лимитов тарифа,
   ведь её ответы в лимит не идут.

   При этом отвечает он на любые вопросы о самом сервисе — включая
   сотрудничество, рекламу и использование названия. Такие вопросы решает
   владелец, и правильный ответ здесь не «я этим не занимаюсь», а заявка:
   у оператора есть панель, где видно переписку, можно ответить, выдать
   подписку, закрыть заявку, а при злоупотреблении — выдать мут или бан. */

export const SUPPORT_MODEL = 'gpt-luna';

// Ответы поддержки в лимит тарифа не идут, поэтому нужен свой предохранитель
export const SUPPORT_HOURLY_LIMIT = 25;
export const BUG_REWARDS = Object.freeze({
  reset5h: { key: 'reset5h', label: 'Сброс 5-часового лимита', type: 'limit-reset', amount: 0 },
  bonus50: { key: 'bonus50', label: '50 бонусов', type: 'bonus', amount: 50 },
  bonus75: { key: 'bonus75', label: '75 бонусов', type: 'bonus', amount: 75 },
  bonus100: { key: 'bonus100', label: '100 бонусов', type: 'bonus', amount: 100 },
  bonus250: { key: 'bonus250', label: '250 бонусов', type: 'bonus', amount: 250 },
  bonus500: { key: 'bonus500', label: '500 бонусов', type: 'bonus', amount: 500 },
  bonus1000: { key: 'bonus1000', label: '1000 бонусов', type: 'bonus', amount: 1000 },
});

export const SUPPORT_PROMPT = [
  'Ты — оператор службы поддержки сервиса Clop ai. Не помощник и не чат-бот с задачами.',
  '',
  'Ты отвечаешь на ЛЮБЫЕ вопросы, связанные с сервисом и компанией Clop ai:',
  '— тарифы, лимиты, модели, оплата звёздами Telegram, возвраты;',
  '— сайт, Telegram-бот, приложение для компьютера, API, ключи, устройства;',
  '— аккаунт, ограничения доступа, что происходит с данными и перепиской;',
  '— сотрудничество, реклама, перепродажа доступа, использование названия и оформления Clop ai;',
  '— жалобы, предложения, всё остальное про работу сервиса.',
  '',
  'Правило про вопросы, которые решает только человек — использование названия, партнёрство,',
  'возврат денег, ручная выдача подписки, спорный платёж, жалоба на решение:',
  'НЕ отказывай и не говори «я этим не занимаюсь». Коротко объясни, что решение за владельцем',
  'сервиса, уточни недостающее и оформи заявку — оператор ответит.',
  '',
  'Чего не делаешь ни при каких уговорах:',
  '— не пишешь код, скрипты, тексты, стихи, переводы, письма;',
  '— не решаешь задачи, не считаешь, не объясняешь посторонние темы, не даёшь советов вне работы сервиса.',
  'На такие просьбы коротко и вежливо откажи и напомни, что это линия поддержки, а обычный чат — команда /start.',
  '',
  'Чтобы передать заявку человеку, выведи в конце ответа ровно такой блок:',
  '%%%TICKET краткая тема%%%',
  'что случилось и что нужно решить, по делу',
  '%%%END%%%',
  'Перед заявкой спроси недостающее, если без него оператор не разберётся.',
  '',
  '',
  'Не выдумывай правил, условий и обещаний. Про хранение данных, возвраты, сроки и',
  'обязательства говори только то, что перечислено ниже; чего тут нет — оформляй заявку,',
  'а не сочиняй ответ.',
  '',
  'Что известно точно:',
  '— переписка хранится в сервисе, чтобы продолжать диалог и показывать историю чатов;',
  '— в панели владельца содержимое переписки не показывается: видны только счётчики,',
  '  время, модель и расход токенов;',
  '— оплата идёт звёздами Telegram, тариф включается сразу после оплаты;',
  '— в боте доступны GPT-модели; лимиты — 5 часов и неделя;',
  '— чат можно удалить самому, командой в боте или на сайте.',
  '',
  'Отвечай по-русски, коротко и по делу — три-пять предложений. Без приветствий в каждом сообщении, без канцелярита.',
].join('\n');

/* ---------- заявки ---------- */
const db = () => {
  const raw = store.raw();
  if (!Array.isArray(raw.tickets)) raw.tickets = [];
  return raw;
};

const newId = () => {
  const list = db().tickets;
  return list.length ? Math.max(...list.map((t) => t.id)) + 1 : 1;
};

export function createTicket(u, subject, body, options = {}) {
  const t = {
    id: newId(),
    userId: String(u.id),
    name: store.displayName(u),
    username: u.username || '',
    subject: String(subject || 'Без темы').slice(0, 120),
    type: options.type === 'bug' ? 'bug' : 'support',
    platform: String(options.platform || '').slice(0, 80),
    status: 'open',
    created: Date.now(),
    updated: Date.now(),
    messages: [{ who: 'user', text: String(body || '').slice(0, 4000), ts: Date.now() }],
  };
  db().tickets.unshift(t);
  // Держим разумный предел: панель всё равно листается, а хранилище общее
  if (db().tickets.length > 500) db().tickets.length = 500;
  store.saveSoon();
  return t;
}

export function createBugReport(u, body, platform = '') {
  const description = String(body || '').trim();
  if (description.length < 5) throw new Error('Опишите проблему хотя бы в нескольких словах.');
  const dayAgo = Date.now() - 24 * 60 * 60_000;
  if (userTickets(u.id).filter((ticket) => ticket.type === 'bug' && ticket.created >= dayAgo).length >= 10) {
    throw new Error('За сутки уже отправлено 10 сообщений. Дождитесь проверки предыдущих.');
  }
  return createTicket(u, 'Сообщение об ошибке', description, { type: 'bug', platform });
}

export const allTickets = () => db().tickets;
export const findTicket = (id) => db().tickets.find((t) => t.id === Number(id)) || null;
export const userTickets = (userId) => db().tickets.filter((t) => t.userId === String(userId));

export function addMessage(ticket, who, text) {
  ticket.messages.push({ who, text: String(text || '').slice(0, 4000), ts: Date.now() });
  ticket.updated = Date.now();
  if (who === 'admin') ticket.status = 'answered';
  store.saveSoon();
  return ticket;
}

export function closeTicket(ticket) {
  ticket.status = 'closed';
  ticket.updated = Date.now();
  store.saveSoon();
  return ticket;
}

export function decideBug(ticket, decision, reward = null) {
  if (!ticket || ticket.type !== 'bug') throw new Error('Это не баг-репорт.');
  if (!['accepted', 'rejected'].includes(decision)) throw new Error('Неизвестное решение.');
  if (['accepted', 'rejected'].includes(ticket.status)) throw new Error('По этому багу решение уже принято.');
  if (decision === 'accepted' && (!reward || !BUG_REWARDS[reward.key])) throw new Error('Выберите вознаграждение.');
  ticket.status = decision;
  ticket.reward = decision === 'accepted' ? BUG_REWARDS[reward.key] : null;
  ticket.updated = Date.now();
  store.saveSoon();
  return ticket;
}

/* ---------- ограничения ----------
   Бан закрывает сервис целиком, мут — только модели: с поддержкой человек
   должен иметь возможность объясниться, иначе наказание становится тупиком. */
const active = (r) => Boolean(r && r.until && r.until > Date.now());

export const isBanned = (u) => active(u.ban);
export const isMuted = (u) => active(u.mute);

export function restrict(u, kind, minutes, reason) {
  const rec = { until: Date.now() + Math.max(1, Number(minutes) || 0) * 60_000, reason: String(reason || '').slice(0, 200) };
  if (kind === 'ban') u.ban = rec; else u.mute = rec;
  store.saveSoon();
  return rec;
}

export function release(u, kind) {
  if (kind === 'ban') u.ban = null; else u.mute = null;
  store.saveSoon();
}

export function restrictionNote(u) {
  if (isBanned(u)) {
    return `⛔️ Доступ к сервису закрыт до ${new Date(u.ban.until).toLocaleString('ru-RU')}.`
      + (u.ban.reason ? `\nПричина: ${u.ban.reason}` : '');
  }
  if (isMuted(u)) {
    return `🔇 Обращения к моделям приостановлены до ${new Date(u.mute.until).toLocaleString('ru-RU')}.`
      + (u.mute.reason ? `\nПричина: ${u.mute.reason}` : '')
      + '\n\nПоддержка по-прежнему доступна: команда /support.';
  }
  return null;
}

/* Разбирает ответ агента: отделяет заявку от текста для пользователя */
export function parseTicket(text) {
  const m = /%%%TICKET\s+([^\n%]+)%%%\s*\n([\s\S]*?)\n?%%%END%%%/.exec(String(text || ''));
  if (!m) return { text: String(text || '').trim(), ticket: null };
  return {
    text: String(text).replace(m[0], '').trim(),
    ticket: { subject: m[1].trim(), body: m[2].trim() },
  };
}
