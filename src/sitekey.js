import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, ensureDirs } from './config.js';

const KEY_FILE = path.join(DATA_DIR, 'site_key.txt');

// Отдельный ключ для веб-сайта на hm550863.webhm.cloud — только для связки
// PHP-прокси на хостинге <-> локальный сервер. Не связан с ботом и с Telegram.
export function getSiteKey() {
  ensureDirs();
  try {
    const existing = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const key = 'site_' + crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}
