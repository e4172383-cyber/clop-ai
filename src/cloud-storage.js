import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(process.env.CLOUD_STORAGE_DIR || path.join(process.cwd(), 'data', 'cloud-storage'));
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MB = 1024 * 1024;
const QUOTAS = Object.freeze({
  free: 500 * MB,
  go: 1000 * MB,
  pro: 1750 * MB,
  max: 5000 * MB,
  max5: 5000 * MB,
  max20: 5000 * MB,
  coderplus: 10 * 1024 * MB,
});

fs.mkdirSync(ROOT, { recursive: true });

export function quotaForPlan(planKey) {
  return QUOTAS[planKey] || QUOTAS.free;
}

function userKey(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32);
}

function locations(userId) {
  const dir = path.join(ROOT, userKey(userId));
  return { dir, blobs: path.join(dir, 'blobs'), index: path.join(dir, 'index.json') };
}

function cleanName(value) {
  const name = path.basename(String(value || 'file.bin')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return (name || 'file.bin').slice(0, 180);
}

function readIndex(userId) {
  const loc = locations(userId);
  try {
    const parsed = JSON.parse(fs.readFileSync(loc.index, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((item) => item && /^[a-f0-9-]{20,64}$/i.test(item.id || '') && /^[a-f0-9]{64}$/i.test(item.hash || '')) : [];
  } catch { return []; }
}

function writeIndex(userId, items) {
  const loc = locations(userId);
  fs.mkdirSync(loc.blobs, { recursive: true });
  const temp = `${loc.index}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(items, null, 2), { mode: 0o600 });
  fs.renameSync(temp, loc.index);
}

function usedBytes(userId, items = readIndex(userId)) {
  const loc = locations(userId);
  let total = 0;
  for (const hash of new Set(items.map((item) => item.hash))) {
    try { total += fs.statSync(path.join(loc.blobs, hash)).size; } catch {}
  }
  return total;
}

function publicItem(item) {
  return {
    id: item.id,
    name: item.name,
    mime: item.mime,
    kind: item.kind,
    size: item.size,
    createdAt: item.createdAt,
    downloadUrl: `/chat/api/storage/file?id=${encodeURIComponent(item.id)}`,
  };
}

export function summary(userId, planKey) {
  const items = readIndex(userId);
  const used = usedBytes(userId, items);
  const quota = quotaForPlan(planKey);
  return {
    ok: true,
    quotaBytes: quota,
    usedBytes: used,
    freeBytes: Math.max(0, quota - used),
    percent: Math.min(100, Math.round(used / quota * 1000) / 10),
    maxFileBytes: MAX_FILE_BYTES,
    files: items.sort((a, b) => b.createdAt - a.createdAt).map(publicItem),
  };
}

export function upload(userId, planKey, { name, mime, kind = 'file', data }) {
  const match = /^(?:data:([^;,]{1,100});base64,)?([A-Za-z0-9+/=\r\n]+)$/.exec(String(data || ''));
  if (!match) throw new Error('Файл должен быть передан в base64.');
  const content = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!content.length) throw new Error('Файл пустой.');
  if (content.length > MAX_FILE_BYTES) throw new Error('Один файл не может быть больше 20 МБ.');
  const safeKind = ['photo', 'chat-file', 'chat-backup', 'file'].includes(kind) ? kind : 'file';
  const safeMime = String(mime || match[1] || 'application/octet-stream').replace(/[^a-zA-Z0-9.+\-/]/g, '').slice(0, 100) || 'application/octet-stream';
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const loc = locations(userId);
  const items = readIndex(userId);
  const blob = path.join(loc.blobs, hash);
  const alreadyStored = fs.existsSync(blob);
  const used = usedBytes(userId, items);
  if (!alreadyStored && used + content.length > quotaForPlan(planKey)) throw new Error('Хранилище заполнено. Удалите файлы или запустите оптимизацию.');
  fs.mkdirSync(loc.blobs, { recursive: true });
  if (!alreadyStored) {
    const temp = `${blob}.${process.pid}.tmp`;
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, blob);
  }
  const item = {
    id: crypto.randomUUID(),
    hash,
    name: cleanName(name),
    mime: safeMime,
    kind: safeKind,
    size: content.length,
    createdAt: Date.now(),
  };
  items.push(item);
  writeIndex(userId, items);
  return { ...summary(userId, planKey), uploaded: publicItem(item), deduplicated: alreadyStored };
}

export function file(userId, id) {
  const item = readIndex(userId).find((entry) => entry.id === String(id || ''));
  if (!item) return null;
  const full = path.join(locations(userId).blobs, item.hash);
  try {
    if (!fs.statSync(full).isFile()) return null;
    return { ...publicItem(item), path: full };
  } catch { return null; }
}

export function remove(userId, planKey, id) {
  const items = readIndex(userId);
  const index = items.findIndex((item) => item.id === String(id || ''));
  if (index < 0) throw new Error('Файл не найден.');
  const [removed] = items.splice(index, 1);
  if (!items.some((item) => item.hash === removed.hash)) {
    try { fs.unlinkSync(path.join(locations(userId).blobs, removed.hash)); } catch {}
  }
  writeIndex(userId, items);
  return { ...summary(userId, planKey), removed: publicItem(removed) };
}

export function backupChats(user, planKey) {
  const date = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    exportedAt: Date.now(),
    chats: (user.chats || []).filter((chat) => !chat.deleted).map((chat) => ({
      id: chat.id,
      title: chat.title,
      model: chat.model,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messages: chat.messages,
    })),
  }, null, 2));
  return upload(user.id, planKey, {
    name: `clop-chats-${date}.json`,
    mime: 'application/json',
    kind: 'chat-backup',
    data: payload.toString('base64'),
  });
}

export function optimize(userId, planKey) {
  const before = usedBytes(userId);
  const loc = locations(userId);
  let items = readIndex(userId).sort((a, b) => b.createdAt - a.createdAt);
  const seen = new Set();
  let backups = 0;
  items = items.filter((item) => {
    if (item.kind === 'chat-backup' && ++backups > 3) return false;
    const key = `${item.hash}:${item.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return fs.existsSync(path.join(loc.blobs, item.hash));
  });
  const usedHashes = new Set(items.map((item) => item.hash));
  try {
    for (const name of fs.readdirSync(loc.blobs)) {
      if (/^[a-f0-9]{64}$/.test(name) && !usedHashes.has(name)) fs.unlinkSync(path.join(loc.blobs, name));
    }
  } catch {}
  writeIndex(userId, items);
  const after = usedBytes(userId, items);
  return { ...summary(userId, planKey), optimizedBytes: Math.max(0, before - after) };
}
