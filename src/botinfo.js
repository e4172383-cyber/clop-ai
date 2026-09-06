// Простой синглтон для username бота — получаем один раз через getMe() при
// старте (index.js) и читаем отсюда там, где нужен t.me-диплинк (сайт-чат).
let username = process.env.BOT_USERNAME || 'clop_ai_bot';

export function setBotUsername(u) {
  if (u) username = u;
}

export function getBotUsername() {
  return username;
}
