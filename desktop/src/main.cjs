'use strict';

const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  safeStorage,
  screen,
  session,
  shell,
} = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  defaults,
  cleanSettings,
  parseAction,
  needsActionRecovery,
  resolveTarget,
  approvalDecision,
} = require('./policy.cjs');
const {
  dedupeResponseFileCandidates,
  decodeInlineResponseFile,
  extractResponseFiles,
  normalizeMimeType,
  normalizeResponseFileCandidate,
  responseFileCandidates,
  sanitizeOutputName,
} = require('./response-files.cjs');

const SERVER = 'https://clop-ai.onrender.com';
const TERMS_FILE = path.join(__dirname, '..', 'TERMS.txt');
const RENDERER_FILE = path.join(__dirname, 'renderer', 'index.html');
const PRELOAD_FILE = path.join(__dirname, 'preload.cjs');
const SMOKE_TEST = process.argv.includes('--smoke-test');
const MAX_HISTORY_MESSAGES = 500;
const MAX_ACTION_LOG = 1_000;
const MAX_READ_BYTES = 1_000_000;
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL = 18 * 1024 * 1024;
const MAX_RESPONSE_FILE_BYTES = 50 * 1024 * 1024;
const MAX_RESPONSE_FILE_TOTAL = 100 * 1024 * 1024;
const MAX_RESPONSE_FILE_COUNT = 12;
const MAX_RESPONSE_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_SHELL_OUTPUT = 1_000_000;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 45_000;
const CHAT_TIMEOUT_MS = 10 * 60 * 1_000;
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

let mainWindow = null;
let dataDir = '';
let settingsFile = '';
let historyFile = '';
let logFile = '';
let authFile = '';
let backupsDir = '';
let backupIndexFile = '';
let responseFilesDir = '';
let settings = { ...defaults };
let chats = [];
let actionLog = [];
let backupIndex = [];
let activeChatId = '';
let accessMode = 'chat';
let token = '';
let account = null;
let pendingLogin = null;
let currentRun = null;
let currentChild = null;
let attachments = new Map();
const pendingApprovals = new Map();

function termsVersion() {
  try {
    const text = fs.readFileSync(TERMS_FILE, 'utf8');
    return text.match(/Версия условий:\s*([^\r\n]+)/i)?.[1]?.trim() || '2026-09-05';
  } catch {
    return '2026-09-05';
  }
}

const AGREEMENT_VERSION = termsVersion();

function id(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}

const backedUpJsonFiles = new Set();

function readJson(file, fallback) {
  for (const candidate of [file, `${file}.bak`]) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch {
      // A valid previous-session copy is tried before falling back to defaults.
    }
  }
  return fallback;
}

function writeJson(file, value) {
  if (!backedUpJsonFiles.has(file)) {
    backedUpJsonFiles.add(file);
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      // Missing or malformed primary files must not replace a known-good backup.
    }
  }
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.copyFileSync(temp, file);
    fs.unlinkSync(temp);
  }
}

const TOKEN_USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'billable'];

function finiteMetric(value, max = 1_000_000_000_000) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(0, Math.round(number))) : null;
}

function cleanTokenUsage(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    const total = finiteMetric(raw);
    return total === null ? null : { total, billable: total };
  }
  if (typeof raw !== 'object') return null;
  const aliases = {
    input: ['input', 'input_tokens'],
    output: ['output', 'output_tokens'],
    cacheRead: ['cacheRead', 'cache_read', 'cache_read_input_tokens', 'cached_input_tokens'],
    cacheWrite: ['cacheWrite', 'cache_write', 'cache_creation_input_tokens'],
    total: ['total', 'total_tokens'],
    billable: ['billable', 'billable_tokens'],
  };
  const result = {};
  for (const [field, keys] of Object.entries(aliases)) {
    for (const key of keys) {
      const value = finiteMetric(raw[key]);
      if (value !== null) {
        result[field] = value;
        break;
      }
    }
  }
  if (!Object.keys(result).length) return null;
  if (result.total === undefined) {
    result.total = (result.input || 0) + (result.output || 0) + (result.cacheRead || 0) + (result.cacheWrite || 0);
  }
  if (result.billable === undefined) result.billable = result.total;
  return result;
}

function addTokenUsage(current, value) {
  const next = cleanTokenUsage(value);
  if (!next) return current;
  const result = { ...(current || {}) };
  for (const field of TOKEN_USAGE_FIELDS) result[field] = (result[field] || 0) + (next[field] || 0);
  return result;
}

function cleanStoredAttachment(raw, role, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const attachmentId = typeof raw.id === 'string' ? raw.id : '';
  const size = finiteMetric(raw.size, MAX_RESPONSE_FILE_BYTES);
  if (role === 'assistant') {
    if (!/^output-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachmentId)) return null;
    const name = sanitizeOutputName(raw.name, index);
    const mimeType = normalizeMimeType(raw.mimeType || raw.mime_type || raw.mime, name);
    return {
      id: attachmentId,
      name,
      size: size || 0,
      mimeType,
      kind: mimeType.startsWith('image/') ? 'image' : 'file',
      source: 'assistant',
      ...(Number.isFinite(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
    };
  }
  if (!/^[a-zA-Z0-9._:-]{1,240}$/.test(attachmentId)) return null;
  return {
    id: attachmentId,
    name: sanitizeOutputName(raw.name, index),
    size: size || 0,
    kind: raw.kind === 'image' ? 'image' : 'document',
  };
}

function cleanStoredChat(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const messages = Array.isArray(raw.messages)
    ? raw.messages.slice(-MAX_HISTORY_MESSAGES).filter((message) =>
      message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
      .map((message) => ({
        role: message.role,
        content: message.content.slice(0, 400_000),
        ts: Number.isFinite(message.ts) ? message.ts : Date.now(),
        ...(typeof message.clientMessageId === 'string' && /^[a-zA-Z0-9._:-]{1,240}$/.test(message.clientMessageId)
          ? { clientMessageId: message.clientMessageId } : {}),
        ...(Array.isArray(message.attachments)
          ? { attachments: message.attachments.slice(0, 12).map((item, index) => cleanStoredAttachment(item, message.role, index)).filter(Boolean) }
          : {}),
        ...(message.role === 'assistant' && typeof message.model === 'string' ? { model: message.model.slice(0, 120) } : {}),
        ...(message.role === 'assistant' && cleanTokenUsage(message.tokens) ? { tokens: cleanTokenUsage(message.tokens) } : {}),
        ...(message.role === 'assistant' && finiteMetric(message.durationMs, 86_400_000) !== null
          ? { durationMs: finiteMetric(message.durationMs, 86_400_000) } : {}),
        ...(message.role === 'assistant' && finiteMetric(message.modelDurationMs, 86_400_000) !== null
          ? { modelDurationMs: finiteMetric(message.modelDurationMs, 86_400_000) } : {}),
        ...(message.role === 'assistant' && finiteMetric(message.steps, 1_000) !== null
          ? { steps: finiteMetric(message.steps, 1_000) } : {}),
      }))
    : [];
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 80) : 'Новый чат',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    remoteChatId: typeof raw.remoteChatId === 'string' ? raw.remoteChatId : '',
    messages,
  };
}

function initialiseStorage() {
  dataDir = app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });
  settingsFile = path.join(dataDir, 'settings.json');
  historyFile = path.join(dataDir, 'history.json');
  logFile = path.join(dataDir, 'action-log.json');
  authFile = path.join(dataDir, 'auth.bin');
  backupsDir = path.join(dataDir, 'backups');
  backupIndexFile = path.join(backupsDir, 'index.json');
  responseFilesDir = path.join(dataDir, 'response-files');
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.mkdirSync(responseFilesDir, { recursive: true });

  const storedSettings = readJson(settingsFile, {});
  settings = cleanSettings(storedSettings, defaults);
  if (typeof storedSettings.workDir === 'string' && storedSettings.workDir.length < 2_000) {
    try {
      const actual = fs.realpathSync(storedSettings.workDir);
      if (fs.statSync(actual).isDirectory()) settings.workDir = actual;
    } catch {
      settings.workDir = '';
    }
  }
  if (storedSettings.agreementVersion === AGREEMENT_VERSION && Number.isFinite(storedSettings.agreementAt)) {
    settings.agreementVersion = AGREEMENT_VERSION;
    settings.agreementAt = storedSettings.agreementAt;
  }

  const history = readJson(historyFile, {});
  chats = (Array.isArray(history.chats) ? history.chats : []).map(cleanStoredChat).filter(Boolean);
  activeChatId = chats.some((chat) => chat.id === history.activeChatId)
    ? history.activeChatId
    : (chats[0]?.id || '');
  const storedActionLog = readJson(logFile, []);
  const storedBackupIndex = readJson(backupIndexFile, []);
  actionLog = (Array.isArray(storedActionLog) ? storedActionLog : []).slice(-MAX_ACTION_LOG);
  backupIndex = (Array.isArray(storedBackupIndex) ? storedBackupIndex : [])
    .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.target === 'string');

  if (fs.existsSync(authFile) && safeStorage.isEncryptionAvailable()) {
    try {
      token = safeStorage.decryptString(fs.readFileSync(authFile));
    } catch {
      token = '';
    }
  }
}

function saveSettings() {
  writeJson(settingsFile, settings);
}

function saveHistory() {
  writeJson(historyFile, { activeChatId, chats });
}

function saveActionLog() {
  writeJson(logFile, actionLog.slice(-MAX_ACTION_LOG));
}

function saveBackupIndex() {
  writeJson(backupIndexFile, backupIndex);
}

function saveToken(value) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Защищённое хранилище Windows сейчас недоступно. Вход не сохранён.');
  }
  const encrypted = safeStorage.encryptString(value);
  fs.writeFileSync(authFile, encrypted, { mode: 0o600 });
  token = value;
}

function clearToken() {
  token = '';
  account = null;
  try {
    fs.unlinkSync(authFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function publicSettings() {
  return { ...settings, workDir: settings.workDir || '' };
}

function publicAttachment(item) {
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    kind: item.kind,
  };
}

function publicResponseFile(item) {
  const name = sanitizeOutputName(item.name);
  const mimeType = normalizeMimeType(item.mimeType || item.mime_type || item.mime, name);
  return {
    id: item.id,
    name,
    size: finiteMetric(item.size, MAX_RESPONSE_FILE_BYTES) || 0,
    mimeType,
    kind: mimeType.startsWith('image/') ? 'image' : 'file',
    source: 'assistant',
    createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
  };
}

function responseFilePath(fileId) {
  if (!/^output-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(fileId || ''))) {
    throw new Error('Некорректный идентификатор файла.');
  }
  const target = path.resolve(responseFilesDir, `${fileId}.bin`);
  const relative = path.relative(path.resolve(responseFilesDir), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Некорректный путь файла.');
  return target;
}

function findResponseFile(fileId) {
  for (const chat of chats) {
    for (const message of chat.messages || []) {
      if (message.role !== 'assistant' || !Array.isArray(message.attachments)) continue;
      const file = message.attachments.find((item) => item?.source === 'assistant' && item.id === fileId);
      if (file) return file;
    }
  }
  throw new Error('Файл не найден в истории чатов.');
}

function dispositionFilename(value) {
  const header = String(value || '');
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { /* fall through */ }
  }
  return header.match(/filename="([^"]+)"/i)?.[1] || header.match(/filename=([^;]+)/i)?.[1]?.trim() || '';
}

async function readLimitedResponseBody(response, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_FILE_BYTES) throw new Error('Файл от ИИ больше 50 МБ.');
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RESPONSE_FILE_BYTES) throw new Error('Файл от ИИ больше 50 МБ.');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let timedOut = false;
  const abortBody = () => reader.cancel('aborted').catch(() => {});
  if (signal) {
    if (signal.aborted) abortBody();
    else signal.addEventListener('abort', abortBody, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel('timeout').catch(() => {});
  }, 2 * 60 * 1_000);
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason || makeAbortError();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_FILE_BYTES) {
        await reader.cancel('too-large').catch(() => {});
        throw new Error('Файл от ИИ больше 50 МБ.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortBody);
  }
  if (signal?.aborted) throw signal.reason || makeAbortError();
  if (timedOut) throw makeAbortError('Скачивание файла от ИИ не завершилось за 2 минуты.');
  return Buffer.concat(chunks, total);
}

async function downloadResponseFile(meta, signal, index) {
  let url;
  try { url = new URL(meta.url, `${SERVER}/`); } catch { throw new Error('API вернул некорректную ссылку на файл.'); }
  const serverUrl = new URL(SERVER);
  if (url.protocol !== 'https:' || url.origin !== serverUrl.origin || url.username || url.password) {
    throw new Error('API может возвращать файлы только со своего защищённого адреса.');
  }
  const response = await fetchWithTimeout(url.href, {
    method: 'GET',
    headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal,
  }, 2 * 60 * 1_000);
  if (!response.ok) await parseResponseError(response);
  const buffer = await readLimitedResponseBody(response, signal);
  const requestedName = meta.raw.name || meta.raw.filename || meta.raw.file_name || meta.raw.path;
  const headerName = dispositionFilename(response.headers.get('content-disposition'));
  const name = sanitizeOutputName(requestedName || headerName, index);
  const mimeType = normalizeMimeType(
    meta.raw.mime_type || meta.raw.mimeType || meta.raw.mime || response.headers.get('content-type'),
    name,
  );
  return { buffer, name, mimeType };
}

async function persistResponseFiles(candidates, signal) {
  const files = [];
  const warnings = [];
  let total = 0;
  const uniqueCandidates = dedupeResponseFileCandidates(candidates);
  const requested = uniqueCandidates.slice(0, MAX_RESPONSE_FILE_COUNT);
  if (uniqueCandidates.length > MAX_RESPONSE_FILE_COUNT) warnings.push(`API вернул больше ${MAX_RESPONSE_FILE_COUNT} файлов; лишние файлы пропущены.`);
  for (let index = 0; index < requested.length; index += 1) {
    const candidate = requested[index];
    let tempPath = '';
    try {
      const meta = normalizeResponseFileCandidate(candidate, index);
      if (meta.declaredSize !== null && meta.declaredSize > MAX_RESPONSE_FILE_BYTES) throw new Error(`${meta.name}: файл больше 50 МБ.`);
      let buffer = decodeInlineResponseFile(meta.raw, MAX_RESPONSE_FILE_BYTES);
      let name = meta.name;
      let mimeType = meta.mimeType;
      if (!buffer && meta.url) {
        const downloaded = await downloadResponseFile(meta, signal, index);
        buffer = downloaded.buffer;
        name = downloaded.name;
        mimeType = downloaded.mimeType;
      }
      if (!buffer) throw new Error(`${meta.name}: API не передал данные или ссылку для скачивания.`);
      const nextTotal = total + buffer.length;
      if (nextTotal > MAX_RESPONSE_FILE_TOTAL) throw new Error('Общий размер файлов ответа превышает 100 МБ.');
      const fileId = id('output-');
      const target = responseFilePath(fileId);
      tempPath = `${target}.${process.pid}.tmp`;
      await fsp.writeFile(tempPath, buffer, { flag: 'wx', mode: 0o600 });
      await fsp.rename(tempPath, target);
      tempPath = '';
      total = nextTotal;
      files.push(publicResponseFile({ id: fileId, name, mimeType, size: buffer.length, createdAt: Date.now() }));
    } catch (error) {
      if (tempPath) await fsp.unlink(tempPath).catch(() => {});
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      warnings.push(String(error?.message || error).slice(0, 500));
    }
  }
  return { files, warnings };
}

async function previewResponseFile(fileId) {
  const file = findResponseFile(fileId);
  const previewable = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);
  if (!previewable.has(file.mimeType)) return { ok: true, previewable: false, file: publicResponseFile(file) };
  const source = responseFilePath(file.id);
  const stat = await fsp.stat(source).catch(() => null);
  if (!stat?.isFile()) throw new Error('Локальная копия файла больше недоступна.');
  if (stat.size > MAX_RESPONSE_PREVIEW_BYTES) return { ok: true, previewable: false, file: publicResponseFile(file) };
  const buffer = await fsp.readFile(source);
  return {
    ok: true,
    previewable: true,
    file: publicResponseFile(file),
    content: `data:${file.mimeType};base64,${buffer.toString('base64')}`,
  };
}

async function saveResponseFile(fileId) {
  const file = findResponseFile(fileId);
  const source = responseFilePath(file.id);
  const stat = await fsp.stat(source).catch(() => null);
  if (!stat?.isFile()) throw new Error('Локальная копия файла больше недоступна.');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Сохранить файл от Clop',
    defaultPath: path.join(app.getPath('downloads'), sanitizeOutputName(file.name)),
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  await fsp.copyFile(source, result.filePath);
  recordAction('response-file', 'done', `${file.name} → ${result.filePath}`, activeChatId);
  return { ok: true, name: file.name, size: stat.size };
}

function publicBackup(entry) {
  return {
    id: entry.id,
    target: entry.target,
    createdAt: entry.createdAt,
    size: entry.size || 0,
    kind: entry.kind,
    reason: entry.reason || 'write',
  };
}

function publicLog(entry) {
  return {
    id: entry.id,
    ts: entry.ts,
    tool: entry.tool,
    status: entry.status,
    summary: entry.summary,
    chatId: entry.chatId || '',
  };
}

function currentChat() {
  return chats.find((chat) => chat.id === activeChatId) || null;
}

function createChat() {
  const now = Date.now();
  const chat = { id: id('chat-'), title: 'Новый чат', createdAt: now, updatedAt: now, remoteChatId: '', messages: [] };
  chats.unshift(chat);
  activeChatId = chat.id;
  saveHistory();
  return chat;
}

function summaryState() {
  return {
    loggedIn: Boolean(token),
    user: account,
    settings: publicSettings(),
    mode: accessMode,
    chats,
    currentChat: currentChat(),
    files: safeRootFiles(),
    logs: actionLog.slice(-100).reverse().map(publicLog),
    backups: backupIndex.slice().reverse().map(publicBackup),
    attachments: [...attachments.values()].map(publicAttachment),
    agreementRequired: settings.agreementVersion !== AGREEMENT_VERSION,
    agreementVersion: AGREEMENT_VERSION,
    busy: Boolean(currentRun),
    busyStartedAt: currentRun?.startedAt || 0,
    pendingApproval: [...pendingApprovals.values()].map((entry) => entry.public)[0] || null,
    version: app.getVersion(),
  };
}

function emit(type, data = {}) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('event', { type, ...data });
}

function recordAction(tool, status, summary, chatId = '') {
  const entry = { id: id('log-'), ts: Date.now(), tool, status, summary: String(summary).slice(0, 2_000), chatId };
  actionLog.push(entry);
  if (actionLog.length > MAX_ACTION_LOG) actionLog = actionLog.slice(-MAX_ACTION_LOG);
  saveActionLog();
  emit('action-log', { entry: publicLog(entry), logs: actionLog.slice(-100).reverse().map(publicLog) });
  return entry;
}

function ensureAgreement() {
  if (settings.agreementVersion !== AGREEMENT_VERSION) {
    throw new Error('Сначала примите актуальные условия использования.');
  }
}

function ensureAuthenticated() {
  if (!token) throw new Error('Войдите через Telegram, чтобы отправить запрос.');
}

function makeAbortError(message = 'Операция остановлена.') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const upstream = options.signal;
  const abort = () => controller.abort(upstream?.reason || makeAbortError());
  if (upstream) {
    if (upstream.aborted) abort();
    else upstream.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(makeAbortError('Сервер не ответил вовремя.')), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener('abort', abort);
  }
}

async function parseResponseError(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body.error || body.message || '';
  } catch {
    try { detail = (await response.text()).slice(0, 500); } catch { /* ignored */ }
  }
  if (response.status === 401) {
    clearToken();
    emit('auth', { loggedIn: false, user: null });
  }
  throw new Error(detail || `Сервер вернул ошибку ${response.status}.`);
}

async function apiJson(endpoint, { method = 'GET', body, auth = false, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    ensureAuthenticated();
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetchWithTimeout(`${SERVER}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) await parseResponseError(response);
  let result;
  try { result = await response.json(); } catch { throw new Error('Сервер вернул некорректный ответ.'); }
  if (result?.ok === false && result?.error) throw new Error(result.error);
  return result;
}

function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    name: typeof raw.name === 'string' ? raw.name : 'Пользователь Clop',
    plan: typeof raw.plan === 'string' ? raw.plan : 'Free',
    planKey: typeof raw.planKey === 'string' ? raw.planKey : 'free',
    models: Array.isArray(raw.models)
      ? raw.models.filter((m) => m && typeof m.key === 'string').map((m) => ({
        key: m.key,
        title: String(m.title || m.key),
        provider: ['gpt', 'kimi'].includes(m.provider) ? m.provider : (m.key.startsWith('gpt-') ? 'gpt' : 'kimi'),
        description: typeof m.description === 'string' ? m.description : '',
        available: m.available !== false,
        plans: Array.isArray(m.plans) ? m.plans.filter((plan) => typeof plan === 'string') : [],
        supportsEffort: m.supportsEffort !== false,
      }))
      : [],
    model: typeof raw.model === 'string' ? raw.model : '',
    limits: raw.limits && typeof raw.limits === 'object' ? raw.limits : null,
    efforts: Array.isArray(raw.efforts)
      ? raw.efforts.filter((e) => e && typeof e.key === 'string').map((e) => ({ key: e.key, title: String(e.title || e.key) }))
      : [],
    effort: ['low', 'medium', 'high', 'xhigh'].includes(raw.effort) ? raw.effort : 'low',
    fast: Boolean(raw.fast),
  };
}

async function refreshAccount(force = false) {
  if (!token) return null;
  if (account && !force) return account;
  const raw = await apiJson('/desk/me', { auth: true });
  account = normalizeAccount(raw);
  if (account) {
    const modelKeys = new Set(account.models.filter((m) => m.available !== false).map((m) => m.key));
    const effortKeys = new Set(account.efforts.map((e) => e.key));
    if ((!settings.model || !modelKeys.has(settings.model)) && modelKeys.has(account.model)) settings.model = account.model;
    if ((!settings.effort || !effortKeys.has(settings.effort)) && effortKeys.has(account.effort)) settings.effort = account.effort;
    if (!fs.existsSync(settingsFile)) settings.fast = account.fast;
    saveSettings();
  }
  return account;
}

function validateChoice(payload = {}) {
  const modelKeys = new Set(account?.models?.filter((model) => model.available !== false).map((model) => model.key) || []);
  const effortKeys = new Set(account?.efforts?.map((effort) => effort.key) || ['low', 'medium', 'high']);
  const requestedModel = typeof payload.model === 'string' ? payload.model : settings.model;
  const requestedEffort = typeof payload.effort === 'string' ? payload.effort : settings.effort;
  const fallbackModel = account?.model || account?.models?.[0]?.key || settings.model;
  const fallbackEffort = account?.effort || account?.efforts?.[0]?.key || settings.effort;
  return {
    model: modelKeys.size && modelKeys.has(requestedModel) ? requestedModel : fallbackModel,
    effort: effortKeys.has(requestedEffort) ? requestedEffort : fallbackEffort,
    fast: typeof payload.fast === 'boolean' ? payload.fast : settings.fast,
  };
}

function safeRootFiles() {
  if (accessMode === 'chat' || !settings.workDir) return [];
  try {
    return listDirectorySync(settings.workDir, '.');
  } catch {
    return [];
  }
}

function listDirectorySync(abs, relativePath) {
  return fs.readdirSync(abs, { withFileTypes: true }).slice(0, 1_000).map((entry) => {
    const absolute = path.join(abs, entry.name);
    let stat = null;
    try { stat = fs.statSync(absolute); } catch { /* ignored */ }
    return {
      name: entry.name,
      path: path.join(relativePath, entry.name).replaceAll('\\', '/'),
      type: entry.isDirectory() ? 'directory' : (entry.isFile() ? 'file' : 'other'),
      size: stat?.isFile() ? stat.size : 0,
      modifiedAt: stat?.mtimeMs || 0,
    };
  }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'ru') : (a.type === 'directory' ? -1 : 1)));
}

function rootForPaths() {
  if (settings.workDir) return settings.workDir;
  if (accessMode === 'full') return os.homedir();
  return '';
}

function resolveForMode(requestedPath) {
  if (accessMode === 'chat') throw new Error('В режиме «Только чат» доступ к файлам отключён.');
  return resolveTarget(rootForPaths(), requestedPath);
}

function approvalSummary(tool, action, target) {
  const labels = {
    list: 'Просмотр папки', read: 'Чтение файла', write: 'Изменение файла', shell: 'Команда Windows',
    screenshot: 'Снимок экрана', click: 'Щелчок мышью', type: 'Ввод текста', key: 'Нажатие клавиши',
    external: 'Открытие внешней ссылки', restore: 'Восстановление резервной копии', attachment: 'Отправка вложений',
  };
  let code = '';
  if (tool === 'shell') code = String(action.command || '').slice(0, 20_000);
  else if (tool === 'write') code = `${target?.abs || action.path}\n\n${String(action.content || '')}`;
  else if (tool === 'type') code = String(action.text || '');
  else if (tool === 'click') code = `x: ${action.x}, y: ${action.y}`;
  else if (tool === 'key') code = action.key;
  else if (tool === 'external') code = action.url;
  else if (tool === 'attachment') code = action.names.join('\n');
  else code = target?.abs || action.path || '';
  return {
    tool,
    kind: labels[tool] || 'Действие',
    title: 'Разрешить действие?',
    description: tool === 'attachment'
      ? 'Выбранные файлы будут отправлены сервису Clop и модели ИИ.'
      : 'Clop запрашивает одноразовое разрешение на следующий шаг.',
    code,
    risk: ['shell', 'write', 'restore'].includes(tool) ? 'Изменяет данные' : 'Требует внимания',
    note: ['click', 'type', 'key'].includes(tool)
      ? 'Действие будет выполнено в активном приложении Windows.'
      : 'Проверьте содержимое и разрешите только ожидаемое действие.',
  };
}

function requestApproval(publicData) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  const approvalId = id('approval-');
  const approval = { id: approvalId, ...publicData };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(approvalId);
      resolve(false);
      emit('approval-expired', { id: approvalId });
    }, APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(approvalId, {
      public: approval,
      finish: (allowed) => {
        clearTimeout(timer);
        pendingApprovals.delete(approvalId);
        resolve(Boolean(allowed));
      },
    });
    emit('approval', { approval, ...approval });
  });
}

function rejectAllApprovals() {
  for (const pending of pendingApprovals.values()) pending.finish(false);
  pendingApprovals.clear();
}

async function authorize(tool, action = {}, target = null, { alwaysAsk = false } = {}) {
  const verdict = approvalDecision(accessMode, tool, target || {}, settings.approvalMode, {
    alwaysAsk,
    targetExists: Boolean(tool === 'write' && target?.abs && fs.existsSync(target.abs)),
  });
  if (verdict === 'deny') throw new Error('Текущий режим доступа не разрешает это действие.');
  if (verdict === 'ask') {
    const allowed = await requestApproval(approvalSummary(tool, action, target));
    if (!allowed) throw new Error('Действие отклонено пользователем.');
  }
}

async function createBackup(target, reason = 'write', chatId = '') {
  const entry = {
    id: id('backup-'),
    target,
    createdAt: Date.now(),
    kind: 'new',
    size: 0,
    reason,
    chatId,
  };
  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error('Изменять можно только обычные файлы.');
    if (stat.size > 100 * 1024 * 1024) throw new Error('Файл слишком большой для безопасной резервной копии.');
    entry.kind = 'existing';
    entry.size = stat.size;
    entry.file = `${entry.id}.bin`;
    await fsp.copyFile(target, path.join(backupsDir, entry.file));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  backupIndex.push(entry);
  saveBackupIndex();
  emit('backups', { backups: backupIndex.slice().reverse().map(publicBackup) });
  return entry;
}

async function restoreBackup(backupId) {
  const entry = backupIndex.find((item) => item.id === backupId);
  if (!entry) throw new Error('Резервная копия не найдена.');
  const target = resolveForMode(entry.target);
  await authorize('restore', { path: entry.target }, target, { alwaysAsk: true });
  if (fs.existsSync(target.abs)) await createBackup(target.abs, 'before-restore');
  if (entry.kind === 'new') {
    try { await fsp.unlink(target.abs); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else {
    const source = path.join(backupsDir, entry.file);
    const sourceReal = path.resolve(source);
    if (!sourceReal.startsWith(`${path.resolve(backupsDir)}${path.sep}`)) throw new Error('Некорректная резервная копия.');
    await fsp.mkdir(path.dirname(target.abs), { recursive: true });
    await fsp.copyFile(source, target.abs);
  }
  recordAction('restore', 'done', entry.target);
  return { ok: true, backup: publicBackup(entry) };
}

function imageMime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' })[ext] || '';
}

async function readTool(target) {
  const stat = await fsp.stat(target.abs);
  if (!stat.isFile()) throw new Error('Путь не является файлом.');
  if (stat.size > MAX_READ_BYTES) throw new Error('Файл больше 1 МБ. Прочитайте меньший фрагмент или выберите другой файл.');
  const buffer = await fsp.readFile(target.abs);
  const mime = imageMime(target.abs);
  if (mime) {
    return {
      result: { ok: true, tool: 'read', path: target.abs, kind: 'image', size: buffer.length },
      images: [`data:${mime};base64,${buffer.toString('base64')}`],
    };
  }
  if (buffer.includes(0)) throw new Error('Двоичный файл нельзя прочитать как текст.');
  return { result: { ok: true, tool: 'read', path: target.abs, content: buffer.toString('utf8') } };
}

async function writeTool(target, action, chatId) {
  const backup = await createBackup(target.abs, 'write', chatId);
  await fsp.mkdir(path.dirname(target.abs), { recursive: true });
  await fsp.writeFile(target.abs, action.content, 'utf8');
  return { result: { ok: true, tool: 'write', path: target.abs, bytes: Buffer.byteLength(action.content), backupId: backup.id } };
}

function appendOutput(chunks, chunk, stream) {
  const text = String(chunk);
  const currentLength = chunks.reduce((sum, part) => sum + part.length, 0);
  if (currentLength >= MAX_SHELL_OUTPUT) return;
  const kept = text.slice(0, MAX_SHELL_OUTPUT - currentLength);
  if (kept) {
    chunks.push(kept);
    stream(kept);
  }
  if (kept.length < text.length) stream('\n[Вывод обрезан: достигнут предел 1 МБ]\n');
}

function stopChild() {
  const child = currentChild;
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
    } catch { child.kill(); }
  } else {
    try { child.kill('SIGTERM'); } catch { /* ignored */ }
  }
}

function runChild(executable, args, options = {}) {
  if (currentChild) return Promise.reject(new Error('Уже выполняется другой процесс.'));
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const child = spawn(executable, args, {
      cwd: options.cwd || rootForPaths() || os.homedir(),
      env: process.env,
      windowsHide: true,
      shell: Boolean(options.shell),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    currentChild = child;
    const onStdout = (chunk) => appendOutput(stdout, chunk, (text) => {
      emit('terminal', { stream: 'stdout', text, command: options.command || '' });
    });
    const onStderr = (chunk) => appendOutput(stderr, chunk, (text) => {
      emit('terminal', { stream: 'stderr', text, command: options.command || '' });
    });
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, (options.timeoutSeconds || settings.shellTimeout) * 1_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      if (currentChild === child) currentChild = null;
      reject(error);
    });
    child.once('close', (code, signalName) => {
      clearTimeout(timer);
      if (currentChild === child) currentChild = null;
      resolve({
        ok: code === 0 && !timedOut,
        code: Number.isInteger(code) ? code : null,
        signal: signalName || '',
        timedOut,
        output: stdout.join(''),
        stderr: stderr.join(''),
      });
    });
  });
}

function runShell(command) {
  const executable = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
  return runChild(executable, args, { command, timeoutSeconds: settings.shellTimeout });
}

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script) {
  if (process.platform !== 'win32') throw new Error('Управление экраном поддерживается только в Windows.');
  return runChild('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)], {
    timeoutSeconds: 20,
    command: '[Windows input action]',
  });
}

async function screenshotTool() {
  const display = screen.getPrimaryDisplay();
  const width = Math.max(1, Math.round(display.bounds.width));
  const height = Math.max(1, Math.round(display.bounds.height));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false });
  const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error('Не удалось получить снимок экрана.');
  return {
    result: { ok: true, tool: 'screenshot', width, height, originX: display.bounds.x, originY: display.bounds.y },
    images: [source.thumbnail.toDataURL()],
  };
}

function clickScript(x, y) {
  return `Add-Type -TypeDefinition @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class ClopMouse {\n [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);\n [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);\n}\n'@\n[ClopMouse]::SetCursorPos(${x}, ${y}) | Out-Null\n[ClopMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)\nStart-Sleep -Milliseconds 45\n[ClopMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)`;
}

function typeScript(text) {
  const value = Buffer.from(text, 'utf8').toString('base64');
  return `Add-Type -TypeDefinition @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class ClopType {\n [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }\n [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }\n [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public UIntPtr extra; }\n [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public UIntPtr extra; }\n [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint msg; public ushort low; public ushort high; }\n [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);\n public static void Text(string value) {\n  foreach (char c in value) {\n   INPUT down = new INPUT(); down.type = 1; down.U.ki.scan = c; down.U.ki.flags = 4;\n   INPUT up = down; up.U.ki.flags = 6;\n   INPUT[] pair = new INPUT[] { down, up }; SendInput(2, pair, Marshal.SizeOf(typeof(INPUT)));\n  }\n }\n}\n'@\n$value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${value}'))\n[ClopType]::Text($value)`;
}

function keyScript(key) {
  const parts = key.split('+');
  const keys = {
    CTRL: 0x11, ALT: 0x12, ENTER: 0x0D, TAB: 0x09, ESC: 0x1B, BACKSPACE: 0x08,
    UP: 0x26, DOWN: 0x28, LEFT: 0x25, RIGHT: 0x27, A: 0x41, C: 0x43, V: 0x56, S: 0x53,
  };
  const values = parts.map((part) => keys[part]);
  return `Add-Type -TypeDefinition @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class ClopKey { [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra); }\n'@\n$keys = @(${values.join(',')})\nforeach ($key in $keys) { [ClopKey]::keybd_event([byte]$key, 0, 0, [UIntPtr]::Zero) }\n[Array]::Reverse($keys)\nforeach ($key in $keys) { [ClopKey]::keybd_event([byte]$key, 0, 2, [UIntPtr]::Zero) }`;
}

function actionEventDetail(action, target) {
  if (target?.abs) return target.abs;
  if (action.tool === 'shell') return String(action.command || '').slice(0, 240);
  if (action.tool === 'click') return `x ${action.x}, y ${action.y}`;
  if (action.tool === 'type') return `${String(action.text || '').length} символов`;
  if (action.tool === 'key') return String(action.key || '');
  if (action.tool === 'screenshot') return 'Основной экран';
  return String(action.path || '').slice(0, 240);
}

async function executeAction(action, chatId) {
  const tool = action.tool;
  let target = null;
  try {
    if (['list', 'read', 'write'].includes(tool)) target = resolveForMode(action.path);
    await authorize(tool, action, target);
    const detail = actionEventDetail(action, target);
    emit('action', { status: 'running', tool, path: action.path || '', detail, chatId });
    let outcome;
    if (tool === 'list') {
      const stat = await fsp.stat(target.abs);
      if (!stat.isDirectory()) throw new Error('Путь не является папкой.');
      outcome = { result: { ok: true, tool, path: target.abs, entries: listDirectorySync(target.abs, action.path) } };
    } else if (tool === 'read') {
      outcome = await readTool(target);
    } else if (tool === 'write') {
      outcome = await writeTool(target, action, chatId);
    } else if (tool === 'shell') {
      const result = await runShell(action.command);
      outcome = { result: { ok: result.ok, tool, code: result.code, timedOut: result.timedOut, output: result.output, stderr: result.stderr } };
    } else if (tool === 'screenshot') {
      outcome = await screenshotTool();
    } else if (tool === 'click') {
      const display = screen.getPrimaryDisplay();
      if (action.x >= display.bounds.width || action.y >= display.bounds.height) throw new Error('Координаты находятся за пределами основного экрана.');
      const result = await runPowerShell(clickScript(display.bounds.x + action.x, display.bounds.y + action.y));
      outcome = { result: { ok: result.ok, tool, x: action.x, y: action.y } };
    } else if (tool === 'type') {
      const result = await runPowerShell(typeScript(action.text));
      outcome = { result: { ok: result.ok, tool, characters: action.text.length } };
    } else if (tool === 'key') {
      const result = await runPowerShell(keyScript(action.key));
      outcome = { result: { ok: result.ok, tool, key: action.key } };
    } else {
      throw new Error('Неизвестное действие.');
    }
    recordAction(tool, 'done', target?.abs || action.command || `${tool}`, chatId);
    emit('action', { status: 'done', tool, detail, chatId, result: outcome.result });
    return outcome;
  } catch (error) {
    recordAction(tool, error.message.includes('отклонено') ? 'denied' : 'error', target?.abs || action.path || action.command || tool, chatId);
    emit('action', { status: 'error', tool, detail: actionEventDetail(action, target), chatId, error: error.message });
    return { result: { ok: false, tool, error: error.message } };
  }
}

function toolProtocol(userText) {
  const location = settings.workDir || (accessMode === 'full' ? os.homedir() : 'не выбрана');
  return `<clop_protocol>\nYou are Clop Code running in a Windows desktop application. Access mode: ${accessMode}. Working directory: ${location}.\nWhen a computer action is necessary, reply with exactly one XML block and valid JSON: <clop_action>{"tool":"list","path":"."}</clop_action>. Available tools: list {path}, read {path}, write {path,content}, shell {command}, screenshot {}, click {x,y}, type {text}, key {key}. Allowed keys: ENTER, TAB, ESC, BACKSPACE, UP, DOWN, LEFT, RIGHT, CTRL+A, CTRL+C, CTRL+V, CTRL+S, ALT+TAB. Paths may be absolute only in full mode. A request to create, build, edit, fix, install, open, run, or test something on the computer is incomplete until you perform the needed actions and receive successful clop_result blocks. For file creation, use write; never merely print code or tell the user to save it. If several files are needed, request one action per turn and continue after each result. If access mode is chat, explain that the user must switch mode instead of pretending the work was performed. Never claim an action succeeded before receiving a <clop_result>. The application enforces its own access policy and may deny a step. Request one action at a time. When the task is complete, answer normally without a clop_action block.\n</clop_protocol>\n<user_request>${JSON.stringify(userText)}</user_request>`;
}

function actionRecoveryPrompt() {
  return '<clop_protocol_reminder>The task is not complete: the user asked you to create or change something on this computer, but you only returned code or instructions. Do not repeat the code as prose and do not ask the user to save it. Continue now with exactly one clop_action using write or another necessary tool. For multiple files, perform them one at a time and wait for each clop_result.</clop_protocol_reminder>';
}

function modelResult(result) {
  const json = JSON.stringify(result).replace(/<\/clop_result>/gi, '<\\/clop_result>');
  return `<clop_result>${json}</clop_result>`;
}

async function readSelectedAttachments(ids) {
  const chosen = ids.map((attachmentId) => attachments.get(attachmentId)).filter(Boolean);
  if (!chosen.length) return { images: [], office: undefined, chosen: [] };
  const allowed = await requestApproval(approvalSummary('attachment', { names: chosen.map((item) => item.name) }, null));
  if (!allowed) throw new Error('Отправка вложений отклонена пользователем.');
  const images = [];
  let office;
  let total = 0;
  for (const item of chosen) {
    const buffer = await fsp.readFile(item.path);
    total += buffer.length;
    if (total > MAX_ATTACHMENT_TOTAL) throw new Error('Общий размер вложений превышает 18 МБ.');
    if (item.kind === 'image') images.push(`data:${item.mime};base64,${buffer.toString('base64')}`);
    else if (!office) office = { name: item.name, data: `data:application/octet-stream;base64,${buffer.toString('base64')}` };
    else throw new Error('За один запрос можно отправить один документ и несколько изображений.');
  }
  recordAction('attachment', 'done', chosen.map((item) => item.name).join(', '), activeChatId);
  return { images, office, chosen };
}

async function chatStream(body, signal) {
  ensureAuthenticated();
  const response = await fetchWithTimeout(`${SERVER}/desk/chat`, {
    method: 'POST',
    headers: { Accept: 'text/event-stream, application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  }, CHAT_TIMEOUT_MS);
  if (!response.ok) await parseResponseError(response);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const value = await response.json();
    if (value?.ok === false) throw new Error(value.error || 'Запрос не выполнен.');
    return {
      ...value,
      text: String(value.text || value.answer || ''),
      files: dedupeResponseFileCandidates(responseFileCandidates(value)),
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let final = null;
  const streamedFiles = [];
  let bodyTimedOut = false;
  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let event;
    try { event = JSON.parse(payload); } catch { return; }
    if (typeof event.delta === 'string') text += event.delta;
    streamedFiles.push(...responseFileCandidates(event));
    if (event.error) throw new Error(String(event.error));
    if (event.done) final = event;
  };
  const bodyTimer = setTimeout(() => {
    bodyTimedOut = true;
    reader.cancel('timeout').catch(() => {});
  }, CHAT_TIMEOUT_MS);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) handleLine(line);
  } finally {
    clearTimeout(bodyTimer);
  }
  if (bodyTimedOut) throw makeAbortError('Сервер не завершил ответ за 10 минут.');
  return {
    ...(final || {}),
    // The final event contains the cleaned, authoritative response. In particular,
    // it replaces streamed %%%FILE markers instead of appending another copy.
    text: String(final?.text ?? text),
    files: dedupeResponseFileCandidates([...streamedFiles, ...responseFileCandidates(final)]),
    ok: final?.ok !== false,
  };
}

async function ask(payload = {}, options = {}) {
  ensureAgreement();
  ensureAuthenticated();
  if (currentRun) throw new Error('Дождитесь текущего ответа или нажмите «Стоп».');
  if (typeof payload === 'string') payload = { text: payload };
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const clientMessageId = typeof payload.clientMessageId === 'string' && /^[a-zA-Z0-9._:-]{1,240}$/.test(payload.clientMessageId)
    ? payload.clientMessageId
    : id('message-');
  const attachmentIds = Array.isArray(payload.attachments)
    ? payload.attachments.map((item) => typeof item === 'string' ? item : item?.id).filter((item) => typeof item === 'string')
    : [];
  if (!text && !attachmentIds.length) throw new Error('Введите сообщение или добавьте вложение.');
  if (text.length > 50_000) throw new Error('Сообщение слишком длинное.');
  await refreshAccount();
  const selected = validateChoice(payload);
  settings = cleanSettings(selected, settings);
  saveSettings();
  let chat = currentChat();
  if (!chat) chat = createChat();
  const selectedAttachments = attachmentIds.map((attachmentId) => attachments.get(attachmentId)).filter(Boolean).map(publicAttachment);
  const retryMessageId = typeof options.retryMessageId === 'string' ? options.retryMessageId : '';
  let userMessage;
  if (retryMessageId) {
    const lastMessage = chat.messages.at(-1);
    if (!lastMessage || lastMessage.role !== 'user' || lastMessage.clientMessageId !== retryMessageId) {
      throw new Error('Этот запрос уже получил ответ или больше не является последним.');
    }
    if (Array.isArray(lastMessage.attachments) && lastMessage.attachments.length) {
      throw new Error('Для повтора запроса с файлами добавьте вложения заново.');
    }
    userMessage = lastMessage;
  } else {
    userMessage = {
      role: 'user',
      content: text,
      ts: Date.now(),
      clientMessageId,
      ...(selectedAttachments.length ? { attachments: selectedAttachments } : {}),
    };
    chat.messages.push(userMessage);
    chat.messages = chat.messages.slice(-MAX_HISTORY_MESSAGES);
    if (chat.title === 'Новый чат') chat.title = (text || selectedAttachments[0]?.name || 'Вложение').replace(/\s+/g, ' ').slice(0, 54);
    chat.updatedAt = Date.now();
    saveHistory();
    emit('message', { chatId: chat.id, message: userMessage, chat });
  }

  const controller = new AbortController();
  const run = { controller, chatId: chat.id, stopped: false, startedAt: Date.now() };
  currentRun = run;
  emit('busy', { value: true, chatId: chat.id, startedAt: run.startedAt });
  let sentAttachments = [];
  const runStartedAt = run.startedAt;
  try {
    const prepared = await readSelectedAttachments(attachmentIds);
    sentAttachments = prepared.chosen;
    let nextText = toolProtocol(text || 'Проанализируй выбранное вложение.');
    let nextImages = prepared.images;
    let nextOffice = prepared.office;
    let finalReply = null;
    let runTokens = null;
    let modelDurationMs = 0;
    let completedSteps = 0;
    let actionRecoveryAttempts = 0;
    for (let step = 0; step < settings.maxSteps; step += 1) {
      if (controller.signal.aborted) throw makeAbortError();
      emit('step', { chatId: chat.id, step: step + 1, maxSteps: settings.maxSteps });
      const response = await chatStream({
        text: nextText,
        clientMessageId: `${clientMessageId}:${step + 1}`,
        model: selected.model,
        chatId: chat.remoteChatId || undefined,
        effort: selected.effort,
        fast: selected.fast,
        ...(nextImages?.length ? { images: nextImages } : {}),
        ...(nextOffice ? { office: nextOffice } : {}),
      }, controller.signal);
      completedSteps = step + 1;
      runTokens = addTokenUsage(runTokens, response.tokens);
      modelDurationMs += finiteMetric(response.durationMs, 86_400_000) || 0;
      if (response.chatId && response.chatId !== chat.remoteChatId) {
        chat.remoteChatId = response.chatId;
        chat.updatedAt = Date.now();
        saveHistory();
      }
      let action;
      try { action = parseAction(response.text); } catch (error) {
        throw new Error(`Ответ модели остановлен: ${error.message}`);
      }
      if (!action) {
        if (accessMode !== 'chat' && actionRecoveryAttempts < 2 && needsActionRecovery(text, response.text)) {
          actionRecoveryAttempts += 1;
          nextText = actionRecoveryPrompt();
          nextImages = [];
          nextOffice = undefined;
          emit('action', {
            status: 'running',
            tool: 'write',
            chatId: chat.id,
            detail: 'Модель вернула код вместо создания файла — исправляем автоматически',
          });
          continue;
        }
        finalReply = response;
        break;
      }
      const outcome = await executeAction(action, chat.id);
      nextText = modelResult(outcome.result);
      nextImages = outcome.images || [];
      nextOffice = undefined;
    }
    if (!finalReply) throw new Error(`Достигнут лимит шагов (${settings.maxSteps}). Продолжите задачу новым сообщением.`);
    const extractedReply = extractResponseFiles(finalReply);
    const persistedReply = await persistResponseFiles(extractedReply.files, controller.signal);
    let content = extractedReply.text.trim();
    if (!content) content = persistedReply.files.length ? 'Готово — файл прикреплён к ответу.' : 'Готово.';
    if (persistedReply.warnings.length) {
      const warning = persistedReply.warnings.length === 1
        ? persistedReply.warnings[0]
        : `Не удалось получить некоторые файлы (${persistedReply.warnings.length}).`;
      emit('file-warning', { chatId: chat.id, message: warning });
      recordAction('response-file', 'error', persistedReply.warnings.join(' | '), chat.id);
      if (!persistedReply.files.length && extractedReply.files.length && !extractedReply.text.trim()) {
        content = `Не удалось получить файл: ${warning}`;
      }
    }
    const durationMs = Date.now() - runStartedAt;
    const assistantMessage = {
      role: 'assistant',
      content,
      ts: Date.now(),
      model: String(finalReply.model || selected.model).slice(0, 120),
      ...(persistedReply.files.length ? { attachments: persistedReply.files } : {}),
      ...(runTokens ? { tokens: runTokens } : {}),
      durationMs,
      modelDurationMs,
      steps: completedSteps,
    };
    chat.messages.push(assistantMessage);
    chat.messages = chat.messages.slice(-MAX_HISTORY_MESSAGES);
    chat.updatedAt = Date.now();
    saveHistory();
    emit('message', { chatId: chat.id, message: assistantMessage, chat, done: true });
    emit('answer', {
      chatId: chat.id,
      text: content,
      model: assistantMessage.model,
      tokens: assistantMessage.tokens,
      durationMs: assistantMessage.durationMs,
      modelDurationMs: assistantMessage.modelDurationMs,
      steps: assistantMessage.steps,
      files: assistantMessage.attachments || [],
    });
    return { ok: true, chat, message: assistantMessage };
  } catch (error) {
    if (error.name === 'AbortError' || run.stopped || controller.signal.aborted) {
      emit('stopped', { chatId: chat.id });
      return { ok: false, stopped: true };
    }
    emit('error', { message: error.message, chatId: chat.id });
    throw error;
  } finally {
    for (const item of sentAttachments) attachments.delete(item.id);
    if (currentRun === run) currentRun = null;
    emit('busy', { value: false, chatId: chat.id });
    emit('attachments', { attachments: [...attachments.values()].map(publicAttachment) });
  }
}

async function stopEverything() {
  if (currentRun) {
    currentRun.stopped = true;
    currentRun.controller.abort(makeAbortError());
  }
  rejectAllApprovals();
  stopChild();
  return { ok: true };
}

function isTrustedEvent(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  const url = event.senderFrame?.url || '';
  return url.startsWith('file:');
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedEvent(event)) throw new Error('Недоверенный источник IPC.');
    return fn(...args);
  });
}

function registerIpc() {
  handle('state', async () => {
    if (token && !account) {
      try { await refreshAccount(); } catch { /* state remains usable offline */ }
    }
    return summaryState();
  });
  handle('settings', async (patch = {}) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Некорректные настройки.');
    const previousSettings = settings;
    const next = cleanSettings(patch, settings);
    if (account) {
      if (typeof patch.model === 'string' && !account.models.some((item) => item.key === patch.model && item.available !== false)) throw new Error('Эта модель недоступна аккаунту.');
      if (typeof patch.effort === 'string' && !account.efforts.some((item) => item.key === patch.effort)) throw new Error('Этот уровень усиления недоступен.');
    }
    settings = next;
    saveSettings();
    try {
      if (token && ['model', 'effort', 'fast'].some((key) => Object.hasOwn(patch, key))) {
        const synced = await apiJson('/desk/profile', {
          method: 'POST', auth: true,
          body: {
            ...(typeof patch.model === 'string' ? { model: patch.model } : {}),
            ...(typeof patch.effort === 'string' ? { effort: patch.effort } : {}),
            ...(typeof patch.fast === 'boolean' ? { fast: patch.fast } : {}),
          },
        });
        settings = cleanSettings(synced, settings);
        account = null;
        await refreshAccount(true);
        saveSettings();
      }
    } catch (error) {
      settings = previousSettings;
      saveSettings();
      throw error;
    }
    emit('settings', { settings: publicSettings() });
    return { ok: true, settings: publicSettings(), user: account };
  });
  handle('terms-accept', async (input = {}) => {
    const version = typeof input === 'string' ? input : input.version;
    if (version && version !== AGREEMENT_VERSION) throw new Error('Версия условий изменилась. Перечитайте актуальный текст.');
    settings.agreementVersion = AGREEMENT_VERSION;
    settings.agreementAt = Date.now();
    saveSettings();
    emit('agreement', { accepted: true, version: AGREEMENT_VERSION });
    return { ok: true, version: AGREEMENT_VERSION, acceptedAt: settings.agreementAt };
  });
  handle('mode', async (requested) => {
    ensureAgreement();
    const mode = typeof requested === 'string' ? requested : requested?.mode;
    if (!['chat', 'workspace', 'full'].includes(mode)) throw new Error('Неизвестный режим доступа.');
    if (mode === 'workspace' && !settings.workDir) {
      return { ok: false, needsFolder: true, mode: accessMode };
    }
    // The renderer presents a dedicated acknowledgement before invoking full mode.
    // The mode intentionally lives only in memory and resets to chat on every launch.
    accessMode = mode;
    emit('mode', { mode: accessMode });
    return { ok: true, mode: accessMode };
  });
  handle('folder', async () => {
    ensureAgreement();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите рабочую папку',
      properties: ['openDirectory', 'createDirectory'],
      securityScopedBookmarks: false,
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const actual = fs.realpathSync(result.filePaths[0]);
    if (!fs.statSync(actual).isDirectory()) throw new Error('Выбранный путь не является папкой.');
    settings.workDir = actual;
    saveSettings();
    if (accessMode === 'chat') accessMode = 'workspace';
    const files = safeRootFiles();
    emit('folder', { path: actual, files, mode: accessMode });
    return { ok: true, path: actual, files, mode: accessMode };
  });
  handle('files', async (requested = '.') => {
    ensureAgreement();
    const targetPath = typeof requested === 'string' ? requested : (requested?.path || '.');
    const target = resolveForMode(targetPath);
    await authorize('list', { path: targetPath }, target);
    const stat = await fsp.stat(target.abs);
    if (!stat.isDirectory()) throw new Error('Путь не является папкой.');
    return listDirectorySync(target.abs, targetPath);
  });
  handle('preview', async (requested) => {
    ensureAgreement();
    const targetPath = typeof requested === 'string' ? requested : requested?.path;
    if (!targetPath) throw new Error('Не выбран файл.');
    const target = resolveForMode(targetPath);
    await authorize('read', { path: targetPath }, target);
    const stat = await fsp.stat(target.abs);
    if (!stat.isFile()) throw new Error('Путь не является файлом.');
    if (stat.size > MAX_READ_BYTES) throw new Error('Предпросмотр ограничен размером 1 МБ.');
    const buffer = await fsp.readFile(target.abs);
    const mime = imageMime(target.abs);
    if (mime) return { name: path.basename(target.abs), path: targetPath, binary: true, mime, content: `data:${mime};base64,${buffer.toString('base64')}`, size: buffer.length };
    if (buffer.includes(0)) return { name: path.basename(target.abs), path: targetPath, binary: true, content: '', size: buffer.length };
    return { name: path.basename(target.abs), path: targetPath, binary: false, content: buffer.toString('utf8'), size: buffer.length };
  });
  handle('response-file', async (request = {}) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Некорректный запрос файла.');
    const fileId = typeof request.id === 'string' ? request.id : '';
    if (request.action === 'preview') return previewResponseFile(fileId);
    if (request.action === 'save') return saveResponseFile(fileId);
    throw new Error('Неизвестное действие с файлом.');
  });
  handle('chat-new', async () => {
    const chat = createChat();
    emit('chat', { chat, chats });
    return chat;
  });
  handle('chat-open', async (requested) => {
    const chatId = typeof requested === 'string' ? requested : requested?.id;
    const chat = chats.find((item) => item.id === chatId);
    if (!chat) throw new Error('Чат не найден.');
    activeChatId = chat.id;
    saveHistory();
    return chat;
  });
  handle('ask', ask);
  handle('answer-retry', async (payload = {}) => {
    const messageId = typeof payload.messageId === 'string' && /^[a-zA-Z0-9._:-]{1,240}$/.test(payload.messageId)
      ? payload.messageId
      : '';
    if (!messageId) throw new Error('Не удалось определить прерванный запрос.');
    const chat = currentChat();
    const message = chat?.messages?.at(-1);
    if (!message || message.role !== 'user' || message.clientMessageId !== messageId) {
      throw new Error('Этот запрос уже получил ответ или больше не является последним.');
    }
    return ask({
      text: message.content,
      clientMessageId: message.clientMessageId,
      model: payload.model,
      effort: payload.effort,
      fast: payload.fast,
    }, { retryMessageId: messageId });
  });
  handle('stop', stopEverything);
  handle('login', async () => {
    ensureAgreement();
    // Сервер принимает 10–32 безопасных символа; 16-символьный случайный код
    // также не подбирается за время десятиминутного окна подтверждения.
    const code = crypto.randomBytes(8).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64url');
    const secretHash = crypto.createHash('sha256').update(secret).digest('base64url');
    const result = await apiJson('/desk/init', {
      method: 'POST',
      body: { code, secretHash, device: `${os.hostname()} · ${process.platform} · Clop Code ${app.getVersion()}` },
    });
    if (!result.ok) throw new Error('Не удалось создать код входа. Повторите попытку.');
    const bot = String(result.bot || '').replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!bot) throw new Error('Сервер не вернул имя Telegram-бота.');
    pendingLogin = { id: id('login-'), code, secret, bot, expiresAt: Date.now() + 10 * 60 * 1_000 };
    const url = `https://t.me/${bot}?start=desk_${encodeURIComponent(code)}`;
    let opened = true;
    try {
      // Запрос login вызывается только явным нажатием кнопки в окне входа, поэтому
      // Telegram можно открыть сразу, без второго диалога разрешения на ссылку.
      await shell.openExternal(url, { activate: true });
    } catch {
      opened = false;
    }
    return { ok: true, id: pendingLogin.id, code, url, bot, opened, expiresAt: pendingLogin.expiresAt };
  });
  handle('login-poll', async (requested) => {
    const loginId = typeof requested === 'string' ? requested : requested?.id;
    if (!pendingLogin || (loginId && pendingLogin.id !== loginId)) return { status: 'expired', error: 'Сеанс входа не найден.' };
    if (Date.now() > pendingLogin.expiresAt) {
      pendingLogin = null;
      return { status: 'expired' };
    }
    const login = pendingLogin;
    const result = await apiJson('/desk/poll', {
      method: 'POST',
      body: { code: login.code, secret: login.secret },
    });
    // Отмена или новый вход могли произойти, пока сервер отвечал.
    if (!pendingLogin || pendingLogin.id !== login.id) return { status: 'expired' };
    if (result.pending) return { status: 'pending', id: login.id };
    if (result.error) {
      pendingLogin = null;
      return { status: 'expired', error: result.error };
    }
    if (!result.token) return { status: 'pending', id: login.id };
    saveToken(String(result.token));
    pendingLogin = null;
    // Ответ подтверждения короткий; полный профиль с моделями, лимитами и
    // настройками всегда перечитываем через защищённый токен устройства.
    account = null;
    account = await refreshAccount(true);
    if (account) {
      if (account.model) settings.model = account.model;
      if (account.effort) settings.effort = account.effort;
      settings.fast = account.fast;
      saveSettings();
    }
    emit('auth', { loggedIn: true, user: account });
    return { status: 'complete', user: account };
  });
  handle('login-cancel', async () => {
    pendingLogin = null;
    return { ok: true };
  });
  handle('me', async () => {
    ensureAuthenticated();
    return { ok: true, user: await refreshAccount(true) };
  });
  handle('logout', async () => {
    if (token) {
      try { await apiJson('/desk/logout', { method: 'POST', auth: true }); } catch { /* local logout must still work */ }
    }
    clearToken();
    pendingLogin = null;
    await stopEverything();
    emit('auth', { loggedIn: false, user: null });
    return { ok: true };
  });
  handle('approve', async (...args) => {
    const first = args[0];
    const approvalId = typeof first === 'string' ? first : first?.id;
    const allowed = typeof first === 'string' ? Boolean(args[1]) : Boolean(first?.allow ?? first?.allowed);
    const pending = pendingApprovals.get(approvalId);
    if (!pending) return { ok: false, expired: true };
    pending.finish(allowed);
    return { ok: true };
  });
  handle('attach', async (request = {}) => {
    if (request && typeof request === 'object' && request.remove) {
      attachments.delete(request.remove);
      return [...attachments.values()].map(publicAttachment);
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Добавить вложение',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Поддерживаемые файлы', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'json', 'csv', 'docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm'] },
        { name: 'Все файлы', extensions: ['*'] },
      ],
    });
    if (result.canceled) return [...attachments.values()].map(publicAttachment);
    const documentExtensions = new Set(['txt', 'md', 'json', 'csv', 'docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm']);
    const selected = [];
    for (const file of result.filePaths.slice(0, 5)) {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) continue;
      const mime = imageMime(file);
      const extension = path.extname(file).slice(1).toLowerCase();
      if (!mime && !documentExtensions.has(extension)) throw new Error(`Формат ${extension || 'файла'} пока не поддерживается.`);
      if (mime && stat.size > MAX_IMAGE_ATTACHMENT_BYTES) throw new Error(`Изображение ${path.basename(file)} больше 8 МБ.`);
      if (!mime && stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`Документ ${path.basename(file)} больше 12 МБ.`);
      selected.push({ id: id('attachment-'), path: fs.realpathSync(file), name: path.basename(file), size: stat.size, kind: mime ? 'image' : 'document', mime });
    }
    const combined = [...attachments.values(), ...selected];
    if (combined.filter((item) => item.kind === 'image').length > 4) throw new Error('За один запрос можно отправить не больше четырёх изображений.');
    if (combined.filter((item) => item.kind === 'document').length > 1) throw new Error('За один запрос можно отправить только один документ.');
    if (combined.reduce((sum, item) => sum + item.size, 0) > MAX_ATTACHMENT_TOTAL) throw new Error('Общий размер вложений превышает 18 МБ.');
    for (const item of selected) attachments.set(item.id, item);
    const resultItems = [...attachments.values()].map(publicAttachment);
    emit('attachments', { attachments: resultItems });
    return resultItems;
  });
  handle('terminal', async (request = {}) => {
    ensureAgreement();
    const command = typeof request === 'string' ? request : request.command;
    if (typeof command !== 'string' || !command.trim() || command.length > 20_000) throw new Error('Некорректная команда.');
    await authorize('shell', { command }, null, { alwaysAsk: true });
    recordAction('shell', 'running', command);
    const result = await runShell(command);
    recordAction('shell', result.ok ? 'done' : 'error', command);
    emit('terminal', { done: true, command, ...result });
    return result;
  });
  handle('backups', async (request = {}) => {
    if (request && typeof request === 'object' && request.restore) return restoreBackup(request.restore);
    return { backups: backupIndex.slice().reverse().map(publicBackup), path: backupsDir };
  });
  handle('window', async (action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    const value = typeof action === 'string' ? action : action?.action;
    if (value === 'minimize') mainWindow.minimize();
    else if (value === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    else if (value === 'close') mainWindow.close();
    else if (value === 'is-maximized') return { ok: true, maximized: mainWindow.isMaximized() };
    else throw new Error('Неизвестное действие окна.');
    return { ok: true, maximized: mainWindow.isMaximized() };
  });
  handle('external', async (requested) => {
    const raw = typeof requested === 'string' ? requested : requested?.url;
    if (raw === 'terms') {
      await shell.openPath(TERMS_FILE);
      return { ok: true };
    }
    let url;
    try { url = new URL(raw); } catch { throw new Error('Некорректная ссылка.'); }
    if (url.protocol !== 'https:') throw new Error('Разрешены только защищённые HTTPS-ссылки.');
    await authorize('external', { url: url.href }, null, { alwaysAsk: true });
    await shell.openExternal(url.href, { activate: true });
    recordAction('external', 'done', url.href);
    return { ok: true };
  });
}

function secureSession() {
  const currentSession = session.defaultSession;
  currentSession.setPermissionCheckHandler(() => false);
  currentSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (typeof currentSession.setDevicePermissionHandler === 'function') currentSession.setDevicePermissionHandler(() => false);
  currentSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#090b10',
    title: 'Clop Code',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: PRELOAD_FILE,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      devTools: !app.isPackaged && !SMOKE_TEST,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => { if (!SMOKE_TEST) mainWindow.show(); });
  mainWindow.on('closed', () => {
    stopEverything();
    mainWindow = null;
  });
  mainWindow.loadFile(RENDERER_FILE);

  if (SMOKE_TEST) {
    const finish = (code) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      app.exit(code);
    };
    mainWindow.webContents.once('did-finish-load', () => setTimeout(() => finish(0), 100));
    mainWindow.webContents.once('did-fail-load', () => finish(1));
    setTimeout(() => finish(1), 15_000).unref();
  }
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    app.setAppUserModelId('com.clop.code.desktop');
    initialiseStorage();
    secureSession();
    registerIpc();
    createWindow();
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
  app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(false);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    rejectAllApprovals();
    stopChild();
  });
}
