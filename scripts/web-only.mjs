// Локальный запуск только веб-части — проверка вёрстки без Telegram
process.env.WEB_PORT = process.env.WEB_PORT || '3000';
const { startWeb } = await import('../src/web.js');
startWeb({ reloadEachRequest: true });
