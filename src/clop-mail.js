import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import * as store from './store.js';
import { planOf } from './limits.js';

const GIB = 1024 ** 3;
export const MAIL_PUBLIC_DOMAIN = String(process.env.MAIL_PUBLIC_DOMAIN || 'clop.195-201-169-74.sslip.io').toLowerCase();
export const MAIL_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAIL_POLICIES = Object.freeze({
  free: Object.freeze({ mailboxes: 2, storageBytes: 10 * GIB }),
  go: Object.freeze({ mailboxes: 5, storageBytes: 20 * GIB }),
  pro: Object.freeze({ mailboxes: 10, storageBytes: 40 * GIB }),
  max: Object.freeze({ mailboxes: 15, storageBytes: 50 * GIB }),
  max20: Object.freeze({ mailboxes: 25, storageBytes: 50 * GIB }),
  coderplus: Object.freeze({ mailboxes: 100, storageBytes: 100 * GIB }),
});

const RESERVED = new Set(['admin', 'abuse', 'hostmaster', 'mailer-daemon', 'no-reply', 'postmaster', 'root', 'security', 'support']);
const MAIL_DIR = path.join(DATA_DIR, 'clop-mail');
let mailMutation = Promise.resolve();

function serializeMailMutation(task) {
  const current = mailMutation.catch(() => undefined).then(task);
  mailMutation = current;
  return current;
}

function state() {
  const db = store.raw();
  if (!db.clopMail || typeof db.clopMail !== 'object') db.clopMail = {};
  if (!db.clopMail.mailboxes || typeof db.clopMail.mailboxes !== 'object') db.clopMail.mailboxes = {};
  if (!db.clopMail.messages || typeof db.clopMail.messages !== 'object') db.clopMail.messages = {};
  return db.clopMail;
}

export function mailPolicy(planKey) {
  return MAIL_POLICIES[planKey] || MAIL_POLICIES.free;
}

export function normalizeLocal(value) {
  let local = String(value || '').trim().toLowerCase();
  if (local.includes('@')) local = local.split('@')[0];
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(local)) return null;
  if (local.includes('..') || local.endsWith('.') || RESERVED.has(local)) return null;
  return local;
}

export function shortAddress(value) {
  const raw = String(value || '').trim().toLowerCase();
  const match = raw.match(/^([^@]+)@(.+)$/);
  if (!match) return null;
  const local = normalizeLocal(match[1]);
  if (!local) return null;
  if (match[2] === 'clop' || match[2] === MAIL_PUBLIC_DOMAIN) return `${local}@clop`;
  return null;
}

export function publicAddress(value) {
  const short = shortAddress(value) || `${normalizeLocal(value)}@clop`;
  const local = short?.split('@')[0];
  return local ? `${local}@${MAIL_PUBLIC_DOMAIN}` : null;
}

export function mailboxByAddress(value) {
  const address = shortAddress(value);
  return address ? state().mailboxes[address] || null : null;
}

export function listMailboxes(user) {
  return Object.values(state().mailboxes)
    .filter((box) => String(box.ownerId) === String(user.id))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function inbox(user, limit = 20) {
  return Object.values(state().messages)
    .filter((message) => String(message.toOwnerId) === String(user.id) && !message.deletedByRecipient)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

export function sent(user, limit = 20) {
  return Object.values(state().messages)
    .filter((message) => String(message.fromOwnerId || '') === String(user.id) && !message.deletedBySender)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

function messageBytes(message) {
  return Math.max(0, Number(message.storageBytes) || 0);
}

export function storageUsed(user) {
  return Object.values(state().messages)
    .filter((message) => (
      (String(message.toOwnerId) === String(user.id) && !message.deletedByRecipient)
      || (String(message.fromOwnerId || '') === String(user.id) && !message.deletedBySender)
    ))
    .reduce((total, message) => total + messageBytes(message), 0);
}

export function mailState(user, planKey) {
  const boxes = listMailboxes(user);
  const policy = mailPolicy(planKey);
  const usedBytes = storageUsed(user);
  return {
    mailboxes: boxes,
    mailboxCount: boxes.length,
    mailboxLimit: policy.mailboxes,
    usedBytes,
    storageBytes: policy.storageBytes,
    storagePercent: Math.min(100, Math.round((usedBytes / policy.storageBytes) * 1000) / 10),
    unread: inbox(user, Number.MAX_SAFE_INTEGER).filter((message) => !message.readAt).length,
  };
}

export function createMailbox(user, requested, planKey, now = Date.now()) {
  const local = normalizeLocal(requested);
  if (!local) return { ok: false, reason: 'invalid' };
  const address = `${local}@clop`;
  if (state().mailboxes[address]) return { ok: false, reason: 'taken' };
  const policy = mailPolicy(planKey);
  if (listMailboxes(user).length >= policy.mailboxes) return { ok: false, reason: 'limit', limit: policy.mailboxes };
  const mailbox = { address, local, ownerId: String(user.id), createdAt: now };
  state().mailboxes[address] = mailbox;
  store.saveSoon();
  return { ok: true, mailbox };
}

function safeFilename(value, index) {
  const cleaned = path.basename(String(value || `attachment-${index + 1}`)).replace(/[^a-zA-Z0-9._() -]/g, '_').slice(0, 120);
  return cleaned || `attachment-${index + 1}`;
}

async function persistAttachments(messageId, attachments = []) {
  if (!attachments.length) return [];
  const dir = path.join(MAIL_DIR, messageId);
  await fs.mkdir(dir, { recursive: true });
  const saved = [];
  for (let index = 0; index < attachments.length; index++) {
    const item = attachments[index];
    const content = Buffer.isBuffer(item.content) ? item.content : Buffer.from(item.content || '');
    if (!content.length) continue;
    if (content.length > MAIL_MAX_ATTACHMENT_BYTES) throw new Error('attachment_too_large');
    const filename = safeFilename(item.filename, index);
    const filePath = path.join(dir, `${index}-${filename}`);
    await fs.writeFile(filePath, content, { flag: 'wx' });
    saved.push({ filename, contentType: String(item.contentType || 'application/octet-stream'), size: content.length, path: filePath });
  }
  return saved;
}

async function removeMessageFiles(message) {
  if (!message?.id) return;
  await fs.rm(path.join(MAIL_DIR, message.id), { recursive: true, force: true }).catch(() => {});
}

function contentBytes({ subject, text, attachments }) {
  return Buffer.byteLength(String(subject || ''), 'utf8') + Buffer.byteLength(String(text || ''), 'utf8')
    + (attachments || []).reduce((sum, item) => sum + Math.max(0, Number(item.size || item.content?.length) || 0), 0);
}

async function deliverInternalUnlocked({ fromUser, from, to, subject, text, attachments = [], now = Date.now() }) {
  const senderBox = mailboxByAddress(from);
  if (!senderBox || String(senderBox.ownerId) !== String(fromUser.id)) return { ok: false, reason: 'sender' };
  const recipientBox = mailboxByAddress(to);
  if (!recipientBox) return { ok: false, reason: 'recipient' };
  const recipient = store.findUser(recipientBox.ownerId);
  if (!recipient) return { ok: false, reason: 'recipient' };
  const bytes = contentBytes({ subject, text, attachments });
  const recipientPolicy = mailPolicy(planOf(recipient).key);
  if (storageUsed(recipient) + bytes > recipientPolicy.storageBytes) return { ok: false, reason: 'recipient_storage' };
  if (String(recipient.id) !== String(fromUser.id)) {
    const senderPolicy = mailPolicy(planOf(fromUser).key);
    if (storageUsed(fromUser) + bytes > senderPolicy.storageBytes) return { ok: false, reason: 'sender_storage' };
  }
  const id = crypto.randomBytes(8).toString('hex');
  let saved = [];
  try {
    saved = await persistAttachments(id, attachments);
    const message = {
      id, from: shortAddress(from), to: recipientBox.address, fromOwnerId: String(fromUser.id), toOwnerId: String(recipient.id),
      subject: String(subject || 'Без темы').trim().slice(0, 120) || 'Без темы', text: String(text || '').slice(0, 20_000),
      attachments: saved, storageBytes: contentBytes({ subject, text, attachments: saved }), createdAt: now,
      readAt: 0, source: 'clop', deletedByRecipient: false, deletedBySender: false,
    };
    state().messages[id] = message;
    await store.save({ strict: true });
    return { ok: true, message, recipient };
  } catch (error) {
    delete state().messages[id];
    await removeMessageFiles({ id });
    throw error;
  }
}

export function deliverInternal(message) {
  return serializeMailMutation(() => deliverInternalUnlocked(message));
}

async function deliverExternalBatchUnlocked({ from, recipients, subject, text, attachments = [], now = Date.now() }) {
  const targets = [];
  const seen = new Set();
  for (const to of recipients || []) {
    const address = shortAddress(to);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const recipientBox = mailboxByAddress(address);
    const recipient = recipientBox && store.findUser(recipientBox.ownerId);
    if (!recipientBox || !recipient) return { ok: false, reason: 'recipient', delivered: [] };
    targets.push({ recipientBox, recipient });
  }
  if (!targets.length) return { ok: false, reason: 'recipient', delivered: [] };
  const bytes = contentBytes({ subject, text, attachments });
  const addedByOwner = new Map();
  for (const { recipient } of targets) {
    const ownerId = String(recipient.id);
    addedByOwner.set(ownerId, (addedByOwner.get(ownerId) || 0) + bytes);
  }
  for (const { recipient } of targets) {
    const ownerId = String(recipient.id);
    const policy = mailPolicy(planOf(recipient).key);
    if (storageUsed(recipient) + addedByOwner.get(ownerId) > policy.storageBytes) {
      return { ok: false, reason: 'recipient_storage', delivered: [] };
    }
  }
  const created = [];
  try {
    for (const { recipientBox, recipient } of targets) {
      const id = crypto.randomBytes(8).toString('hex');
      const saved = await persistAttachments(id, attachments);
      const message = {
        id, from: String(from || 'unknown').trim().toLowerCase().slice(0, 254), to: recipientBox.address,
        fromOwnerId: null, toOwnerId: String(recipient.id), subject: String(subject || 'Без темы').trim().slice(0, 120) || 'Без темы',
        text: String(text || '').slice(0, 20_000), attachments: saved,
        storageBytes: contentBytes({ subject, text, attachments: saved }), createdAt: now, readAt: 0,
        source: 'internet', deletedByRecipient: false, deletedBySender: false,
      };
      state().messages[id] = message;
      created.push({ ok: true, message, recipient });
    }
    await store.save({ strict: true });
    return { ok: true, delivered: created };
  } catch (error) {
    for (const item of created) {
      delete state().messages[item.message.id];
      await removeMessageFiles(item.message);
    }
    throw error;
  }
}

export function deliverExternalBatch(message) {
  return serializeMailMutation(() => deliverExternalBatchUnlocked(message));
}

export async function deliverExternal(message) {
  const result = await deliverExternalBatch({ ...message, recipients: [message.to] });
  return result.ok ? result.delivered[0] : result;
}

export function getMessage(user, id, { markRead = true } = {}) {
  const message = state().messages[String(id)] || null;
  if (!message) return null;
  const isRecipient = String(message.toOwnerId) === String(user.id) && !message.deletedByRecipient;
  const isSender = String(message.fromOwnerId || '') === String(user.id) && !message.deletedBySender;
  if (!isRecipient && !isSender) return null;
  if (isRecipient && markRead && !message.readAt) { message.readAt = Date.now(); store.saveSoon(); }
  return message;
}

async function deleteMessageUnlocked(user, id) {
  const message = state().messages[String(id)] || null;
  if (!message) return false;
  let changed = false;
  if (String(message.toOwnerId) === String(user.id)) { message.deletedByRecipient = true; changed = true; }
  if (String(message.fromOwnerId || '') === String(user.id)) { message.deletedBySender = true; changed = true; }
  if (!changed) return false;
  if (message.deletedByRecipient && (!message.fromOwnerId || message.deletedBySender)) {
    delete state().messages[message.id];
    await removeMessageFiles(message);
  }
  await store.save({ strict: true });
  return true;
}

export function deleteMessage(user, id) {
  return serializeMailMutation(() => deleteMessageUnlocked(user, id));
}

async function deleteMailboxUnlocked(user, value) {
  const address = shortAddress(value);
  const mailbox = address && state().mailboxes[address];
  if (!mailbox || String(mailbox.ownerId) !== String(user.id)) return false;
  delete state().mailboxes[address];
  const messages = Object.values(state().messages).filter((message) => message.to === address && String(message.toOwnerId) === String(user.id));
  for (const message of messages) {
    message.deletedByRecipient = true;
    if (!message.fromOwnerId || message.deletedBySender) {
      delete state().messages[message.id];
      await removeMessageFiles(message);
    }
  }
  await store.save({ strict: true });
  return true;
}

export function deleteMailbox(user, value) {
  return serializeMailMutation(() => deleteMailboxUnlocked(user, value));
}

export async function attachmentData(user, messageId, index) {
  const message = getMessage(user, messageId, { markRead: false });
  const attachment = message?.attachments?.[Number(index)];
  if (!attachment?.path) return null;
  const resolved = path.resolve(attachment.path);
  const allowed = path.resolve(MAIL_DIR) + path.sep;
  if (!resolved.startsWith(allowed)) return null;
  return { ...attachment, content: await fs.readFile(resolved) };
}

async function recordExternalSentUnlocked({ fromUser, from, to, subject, text, attachments = [], now = Date.now() }) {
  const senderBox = mailboxByAddress(from);
  if (!senderBox || String(senderBox.ownerId) !== String(fromUser.id)) return null;
  const bytes = contentBytes({ subject, text, attachments });
  if (storageUsed(fromUser) + bytes > mailPolicy(planOf(fromUser).key).storageBytes) return null;
  const id = crypto.randomBytes(8).toString('hex');
  try {
    const saved = await persistAttachments(id, attachments);
    const message = {
      id, from: senderBox.address, to: String(to).toLowerCase(), fromOwnerId: String(fromUser.id), toOwnerId: null,
      subject: String(subject || 'Без темы').trim().slice(0, 120) || 'Без темы', text: String(text || '').slice(0, 20_000),
      attachments: saved, storageBytes: contentBytes({ subject, text, attachments: saved }), createdAt: now, readAt: now,
      source: 'outbound', deliveryStatus: 'sending', deliveryError: '', deletedByRecipient: true, deletedBySender: false,
    };
    state().messages[id] = message;
    await store.save({ strict: true });
    return message;
  } catch (error) {
    delete state().messages[id];
    await removeMessageFiles({ id });
    throw error;
  }
}

export function recordExternalSent(message) {
  return serializeMailMutation(() => recordExternalSentUnlocked(message));
}

export async function updateOutboundStatus(messageId, status, error = '') {
  const message = state().messages[String(messageId)];
  if (!message || message.source !== 'outbound') return false;
  message.deliveryStatus = status === 'sent' ? 'sent' : 'failed';
  message.deliveryError = String(error || '').slice(0, 300);
  message.deliveredAt = status === 'sent' ? Date.now() : 0;
  await store.save({ strict: true });
  return true;
}
