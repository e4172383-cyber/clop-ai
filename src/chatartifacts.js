import crypto from 'node:crypto';

import { mimeForPath } from './files.js';
import { redisClient } from './store.js';

export const ARTIFACT_TTL_SECONDS = 24 * 60 * 60;

const KEY_PREFIX = 'clop:chat-artifact:';
const memory = new Map();

const keyOf = (id) => KEY_PREFIX + id;
const downloadUrl = (id, index) => `/chat/api/artifact?id=${id}.${index}`;

function sweepMemory(now = Date.now()) {
  for (const [id, bundle] of memory) {
    if (!bundle || bundle.expiresAt <= now) memory.delete(id);
  }
}

function publicFiles(bundle) {
  return bundle.files.map((file, index) => ({
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    downloadUrl: downloadUrl(bundle.id, index),
    expiresAt: bundle.expiresAt,
  }));
}

export async function saveArtifacts(ownerId, files) {
  if (!Array.isArray(files) || !files.length) return [];

  const now = Date.now();
  const bundle = {
    id: crypto.randomBytes(18).toString('base64url'),
    ownerId: String(ownerId),
    createdAt: now,
    expiresAt: now + ARTIFACT_TTL_SECONDS * 1000,
    files: files.map((file) => {
      const content = String(file.content ?? '');
      return {
        name: String(file.path || 'file.txt'),
        content,
        size: Buffer.byteLength(content, 'utf8'),
        mimeType: mimeForPath(file.path),
      };
    }),
  };

  memory.set(bundle.id, bundle);
  sweepMemory(now);

  const redis = redisClient();
  if (redis) {
    try {
      await redis.set(keyOf(bundle.id), bundle, { ex: ARTIFACT_TTL_SECONDS });
    } catch (error) {
      console.error('[chat-artifacts] запись не удалась', error.message);
    }
  }

  return publicFiles(bundle);
}

export async function getArtifact(ownerId, token) {
  const match = /^([A-Za-z0-9_-]{20,40})\.(\d+)$/.exec(String(token || ''));
  if (!match) return null;
  const [, id, indexText] = match;
  const index = Number(indexText);
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(id || ''))) return null;
  if (!Number.isSafeInteger(index) || index < 0) return null;

  const now = Date.now();
  sweepMemory(now);
  let bundle = memory.get(id) || null;

  if (!bundle) {
    const redis = redisClient();
    if (redis) {
      try {
        bundle = await redis.get(keyOf(id));
      } catch (error) {
        console.error('[chat-artifacts] чтение не удалось', error.message);
      }
    }
  }

  if (!bundle || !Number.isFinite(bundle.expiresAt) || bundle.expiresAt <= now
    || bundle.ownerId !== String(ownerId)) return null;
  const file = Array.isArray(bundle.files) ? bundle.files[index] : null;
  if (!file || typeof file.content !== 'string') return null;
  return {
    name: String(file.name || 'file.txt'),
    content: file.content,
    size: Buffer.byteLength(file.content, 'utf8'),
    mimeType: mimeForPath(file.name),
  };
}
