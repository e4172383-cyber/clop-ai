import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { redisClient } from './store.js';

const KEY = 'clop:kimiauth';
const SEED = 'clop:kimiauth:seed';
export const home = () => process.env.KIMI_CODE_HOME || path.join(os.tmpdir(), 'clop-kimi-code');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
let lastSaved = null;

function hasOAuthCredentials(dir) {
  const credentialsDir = path.join(dir, 'credentials');
  if (!fs.existsSync(credentialsDir)) return false;
  try {
    return fs.readdirSync(credentialsDir, { withFileTypes: true }).some((entry) => {
      if (!entry.isFile() || !entry.name.endsWith('.json')) return false;
      try {
        const value = JSON.parse(fs.readFileSync(path.join(credentialsDir, entry.name), 'utf8'));
        return typeof value?.access_token === 'string' && value.access_token.length > 20;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function isReady(dir = home()) {
  try {
    const config = path.join(dir, 'config.toml');
    return fs.existsSync(config) && fs.statSync(config).size > 0 && hasOAuthCredentials(dir);
  } catch {
    return false;
  }
}

function safeRelative(rel) {
  return rel && !path.isAbsolute(rel) && !rel.split(/[\\/]+/).includes('..');
}

function unpack(b64) {
  const files = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Некорректный снимок входа Kimi');
  fs.mkdirSync(home(), { recursive: true });
  for (const [rel, value] of Object.entries(files)) {
    if (!safeRelative(rel) || typeof value !== 'string') throw new Error('Некорректный путь входа Kimi');
    const target = path.join(home(), rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(value, 'base64'), { mode: 0o600 });
  }
}

function collect(dir, prefix = '') {
  const result = {};
  if (!fs.existsSync(dir)) return result;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['logs', 'sessions', 'plans', 'plugins', 'user-history'].includes(item.name)) continue;
    const rel = prefix ? path.join(prefix, item.name) : item.name;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) Object.assign(result, collect(full, rel));
    else if (item.isFile()) result[rel.replaceAll('\\', '/')] = fs.readFileSync(full).toString('base64');
  }
  return result;
}

export function snapshot() {
  const files = collect(home());
  if (!Object.keys(files).length) return null;
  return Buffer.from(JSON.stringify(files)).toString('base64');
}

export async function restore() {
  const seed = process.env.KIMI_AUTH_B64 || '';
  const seedHash = seed ? hash(seed) : null;
  const redis = redisClient();
  try {
    if (redis) {
      const [saved, savedSeed] = await Promise.all([redis.get(KEY), redis.get(SEED)]);
      if (saved && (!seed || savedSeed === seedHash)) {
        unpack(saved);
        lastSaved = hash(saved);
        console.log('[kimi] вход восстановлен из Redis');
        return true;
      }
    }
    if (seed) {
      unpack(seed);
      lastSaved = null;
      await save();
      if (redis && seedHash) await redis.set(SEED, seedHash);
      console.log('[kimi] вход восстановлен из переменной окружения');
      return true;
    }
  } catch (e) {
    console.warn('[kimi] не удалось восстановить вход:', e.message);
  }
  return false;
}

export async function save() {
  const redis = redisClient();
  if (!redis) return false;
  const packed = snapshot();
  if (!packed) return false;
  const current = hash(packed);
  if (current === lastSaved) return false;
  await redis.set(KEY, packed);
  lastSaved = current;
  return true;
}

export function watch(everyMs = 60_000) {
  setInterval(() => save().catch((e) => console.warn('[kimi] сохранение входа:', e.message)), everyMs).unref();
}
