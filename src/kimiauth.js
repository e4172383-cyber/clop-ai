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

export function sessionInfo(dir = home()) {
  if (!isReady(dir)) return null;
  try {
    const credentialsDir = path.join(dir, 'credentials');
    for (const entry of fs.readdirSync(credentialsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const value = JSON.parse(fs.readFileSync(path.join(credentialsDir, entry.name), 'utf8'));
      if (typeof value?.access_token !== 'string' || value.access_token.length <= 20) continue;
      const config = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
      const baseUrl = config.match(/base_url\s*=\s*"([^"]+)"/)?.[1]
        || (fs.readFileSync(path.join(dir, 'region'), 'utf8').trim() === 'global'
          ? 'https://api.kimi.ai/coding/v1' : 'https://api.kimi.com/coding/v1');
      return { accessToken: value.access_token, baseUrl: baseUrl.replace(/\/+$/, '') };
    }
  } catch {}
  return null;
}

function tokenRecord(dir = home()) {
  const credentialsDir = path.join(dir, 'credentials');
  if (!fs.existsSync(credentialsDir)) return null;
  for (const entry of fs.readdirSync(credentialsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(credentialsDir, entry.name);
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof value?.access_token === 'string' && value.access_token.length > 20) return { file, value };
    } catch {}
  }
  return null;
}

function authHost(dir = home()) {
  try {
    const region = fs.readFileSync(path.join(dir, 'region'), 'utf8').trim();
    return region === 'global' ? 'https://auth.kimi.ai' : 'https://auth.kimi.com';
  } catch {
    return 'https://auth.kimi.com';
  }
}

export async function refreshSessionInfo({ dir = home(), force = false, fetchImpl = fetch, oauthHost = authHost(dir) } = {}) {
  const record = tokenRecord(dir);
  if (!record) return null;
  const expiresAt = Number(record.value.expires_at || 0) * 1000;
  if (!force && expiresAt > Date.now() + 60_000) return sessionInfo(dir);
  const refreshToken = record.value.refresh_token;
  if (typeof refreshToken !== 'string' || refreshToken.length < 20) return sessionInfo(dir);
  const response = await fetchImpl(`${String(oauthHost).replace(/\/+$/, '')}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: '17e5f671-d194-4dfb-9706-5516cb48c098',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.access_token !== 'string' || payload.access_token.length < 20) {
    throw new Error(`Kimi OAuth refresh failed (HTTP ${response.status})`);
  }
  const next = {
    ...record.value,
    access_token: payload.access_token,
    refresh_token: typeof payload.refresh_token === 'string' && payload.refresh_token.length >= 20
      ? payload.refresh_token : refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + Math.max(60, Number(payload.expires_in) || 3600),
    ...(typeof payload.scope === 'string' ? { scope: payload.scope } : {}),
    ...(typeof payload.token_type === 'string' ? { token_type: payload.token_type } : {}),
  };
  const temporary = `${record.file}.refresh-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, record.file);
  await save();
  return sessionInfo(dir);
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
        if (isReady()) {
          lastSaved = hash(saved);
          console.log('[kimi] вход восстановлен из Redis');
          return true;
        }
        console.warn('[kimi] снимок входа в Redis неполный, используется резервная копия');
      }
    }
    if (seed) {
      unpack(seed);
      if (!isReady()) throw new Error('Резервная копия входа Kimi неполная');
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
