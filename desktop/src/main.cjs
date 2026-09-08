'use strict';

const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
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
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { launchWindowsUpdate } = require('./update-helper.cjs');
const {
  defaults,
  cleanSettings,
  parseAction,
  requiresComputerAction,
  isUnnecessaryClarification,
  looksLikeCodeDelivery,
  needsActionRecovery,
  codeFallbackAction,
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
const AGENT_FILE = path.join(__dirname, 'renderer', 'agent.html');
const AGENT_TASKS_FILE = path.join(__dirname, 'renderer', 'agent-tasks.html');
const REMOTE_OVERLAY_FILE = path.join(__dirname, 'renderer', 'remote-overlay.html');
const AGENT_PRELOAD_FILE = path.join(__dirname, 'agent-preload.cjs');
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
// Пользователь не выбирает искусственный предел шагов. Этот высокий аварийный
// потолок защищает только от зациклившейся модели; обычная задача идёт до конца.
const MAX_AUTONOMOUS_ACTIONS = 200;
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
let agentWindow = null;
let agentTasksWindow = null;
let remoteOverlayWindow = null;
let agentDrag = null;
let agentCursorTimer = null;
let agentNetworkTimer = null;
let remotePollTimer = null;
let remotePolling = false;
let remoteRequest = null;
let remoteSession = null;
let remoteCommandBusy = false;
let agentOnline = false;
let isQuitting = false;
let dataDir = '';
let settingsFile = '';
let historyFile = '';
let logFile = '';
let authFile = '';
let backupsDir = '';
let backupIndexFile = '';
let responseFilesDir = '';
let qualityLogFile = '';
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
  const valid = [];
  for (const candidate of [file, `${file}.bak`]) {
    try {
      valid.push({
        value: JSON.parse(fs.readFileSync(candidate, 'utf8')),
        modifiedAt: fs.statSync(candidate).mtimeMs,
        primary: candidate === file,
      });
    } catch {
      // Missing or malformed candidates are ignored.
    }
  }
  valid.sort((a, b) => (b.modifiedAt - a.modifiedAt) || Number(b.primary) - Number(a.primary));
  return valid[0]?.value ?? fallback;
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
        ...(message.role === 'user' && message.hint === true ? { hint: true } : {}),
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
  qualityLogFile = path.join(dataDir, 'ai-quality.jsonl');
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.mkdirSync(responseFilesDir, { recursive: true });
  try {
    if (fs.existsSync(qualityLogFile) && fs.statSync(qualityLogFile).size > 5 * 1024 * 1024) {
      fs.renameSync(qualityLogFile, `${qualityLogFile}.previous`);
    }
    fs.closeSync(fs.openSync(qualityLogFile, 'a', 0o600));
  } catch { /* the app remains usable if local diagnostics cannot be opened */ }

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

function qualitySnippet(value, max = 2_000) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}

function logQuality(kind, detail = {}) {
  if (!qualityLogFile) return;
  const record = {
    ts: new Date().toISOString(),
    version: app.getVersion(),
    kind: qualitySnippet(kind, 80),
    chatId: qualitySnippet(detail.chatId, 120),
    model: qualitySnippet(detail.model || settings.model, 120),
    request: qualitySnippet(detail.request),
    response: qualitySnippet(detail.response),
    error: qualitySnippet(detail.error),
    action: qualitySnippet(detail.action),
  };
  try { fs.appendFileSync(qualityLogFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 }); } catch {}
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
    remote: {
      version: '1.1 Beta',
      request: remoteRequest,
      session: remoteSession,
      enabled: settings.remoteRequests !== false,
    },
    version: app.getVersion(),
  };
}

function emit(type, data = {}) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('event', { type, ...data });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function positionAgent() {
  if (!agentWindow || agentWindow.isDestroyed()) return;
  const saved = settings.agentPosition;
  const display = saved
    ? screen.getDisplayNearestPoint({ x: saved.x + 58, y: saved.y + 58 })
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const desiredX = saved?.x ?? (area.x + area.width - 142);
  const desiredY = saved?.y ?? (area.y + area.height - 142);
  const x = Math.max(area.x, Math.min(area.x + area.width - 116, desiredX));
  const y = Math.max(area.y, Math.min(area.y + area.height - 116, desiredY));
  agentWindow.setPosition(Math.round(x), Math.round(y), false);
  positionAgentTasks();
}

function sendAgent(channel, value) {
  if (!agentWindow || agentWindow.isDestroyed() || agentWindow.webContents.isDestroyed()) return;
  agentWindow.webContents.send(channel, value);
}

function agentTaskItems() {
  if (!currentRun) return [];
  const items = actionLog.filter((entry) => entry.chatId === currentRun.chatId && entry.ts >= currentRun.startedAt)
    .slice(-30).map(publicLog);
  return items.length ? items : [{ id: 'thinking', ts: currentRun.startedAt, tool: 'thinking', status: 'running', summary: 'Анализирует запрос' }];
}

function positionAgentTasks() {
  if (!agentTasksWindow || agentTasksWindow.isDestroyed() || !agentWindow || agentWindow.isDestroyed()) return;
  const agent = agentWindow.getBounds();
  const area = screen.getDisplayMatching(agent).workArea;
  const width = 344;
  const height = 196;
  const x = Math.max(area.x, Math.min(area.x + area.width - width, agent.x + agent.width - width));
  const above = agent.y - height - 8;
  const y = above >= area.y ? above : Math.min(area.y + area.height - height, agent.y + agent.height + 8);
  agentTasksWindow.setBounds({ x: Math.round(x), y: Math.round(y), width, height }, false);
}

function syncAgentTasks() {
  if (!agentTasksWindow || agentTasksWindow.isDestroyed()) return;
  const tasks = agentTaskItems();
  if (!currentRun || settings.agentVisible === false) {
    agentTasksWindow.hide();
    return;
  }
  positionAgentTasks();
  agentTasksWindow.webContents.send('agent-tasks', { tasks });
  agentTasksWindow.showInactive();
}

function createAgentTasksWindow() {
  if (SMOKE_TEST || agentTasksWindow && !agentTasksWindow.isDestroyed()) return;
  agentTasksWindow = new BrowserWindow({
    width: 344, height: 196, show: false, transparent: true, backgroundColor: '#00000000', frame: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, hasShadow: false, autoHideMenuBar: true, title: 'Clop Agent Tasks',
    webPreferences: { preload: AGENT_PRELOAD_FILE, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: !app.isPackaged },
  });
  agentTasksWindow.setAlwaysOnTop(true, 'floating');
  agentTasksWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  agentTasksWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  agentTasksWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== agentTasksWindow.webContents.getURL()) event.preventDefault();
  });
  agentTasksWindow.webContents.once('did-finish-load', syncAgentTasks);
  agentTasksWindow.on('closed', () => { agentTasksWindow = null; });
  agentTasksWindow.loadFile(AGENT_TASKS_FILE);
}

async function checkAgentNetwork() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(`${SERVER}/health`, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timeout);
    agentOnline = response.ok;
  } catch {
    agentOnline = false;
  }
  sendAgent('agent-network', { online: agentOnline });
}

function startAgentUpdates() {
  clearInterval(agentCursorTimer);
  clearInterval(agentNetworkTimer);
  agentCursorTimer = setInterval(() => {
    if (!agentWindow || agentWindow.isDestroyed() || !agentWindow.isVisible()) return;
    sendAgent('agent-cursor', { point: screen.getCursorScreenPoint(), bounds: agentWindow.getBounds() });
  }, 34);
  agentCursorTimer.unref?.();
  checkAgentNetwork();
  agentNetworkTimer = setInterval(checkAgentNetwork, 10_000);
  agentNetworkTimer.unref?.();
}

function createAgentWindow() {
  if (SMOKE_TEST || agentWindow && !agentWindow.isDestroyed()) return;
  agentWindow = new BrowserWindow({
    width: 116,
    height: 116,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    autoHideMenuBar: true,
    title: 'Clop Agent',
    webPreferences: {
      preload: AGENT_PRELOAD_FILE,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
  });
  agentWindow.setAlwaysOnTop(true, 'floating');
  agentWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  agentWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  agentWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== agentWindow.webContents.getURL()) event.preventDefault();
  });
  agentWindow.once('ready-to-show', () => {
    positionAgent();
    if (settings.agentVisible !== false) agentWindow.showInactive();
  });
  agentWindow.on('closed', () => { agentWindow = null; });
  agentWindow.loadFile(AGENT_FILE);
  createAgentTasksWindow();
  startAgentUpdates();
}

function syncAgentVisibility() {
  if (SMOKE_TEST) return;
  if (!agentWindow || agentWindow.isDestroyed()) createAgentWindow();
  if (!agentWindow || agentWindow.isDestroyed()) return;
  if (settings.agentVisible === false) {
    agentWindow.hide();
    agentTasksWindow?.hide();
  }
  else {
    positionAgent();
    agentWindow.showInactive();
  }
}

function sendRemoteOverlay(value = {}) {
  if (!remoteOverlayWindow || remoteOverlayWindow.isDestroyed() || remoteOverlayWindow.webContents.isDestroyed()) return;
  remoteOverlayWindow.webContents.send('remote-overlay-state', value);
}

function createRemoteOverlay() {
  if (SMOKE_TEST || remoteOverlayWindow && !remoteOverlayWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  remoteOverlayWindow = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
    show: false, transparent: true, backgroundColor: '#00000000', frame: false,
    resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false,
    autoHideMenuBar: true, title: 'Clop Remote 1.1 Beta',
    webPreferences: { preload: AGENT_PRELOAD_FILE, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: !app.isPackaged },
  });
  remoteOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
  remoteOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  remoteOverlayWindow.setContentProtection(true);
  remoteOverlayWindow.setIgnoreMouseEvents(true, { forward: true });
  remoteOverlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  remoteOverlayWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== remoteOverlayWindow.webContents.getURL()) event.preventDefault();
  });
  remoteOverlayWindow.webContents.once('did-finish-load', () => {
    if (!remoteSession) return;
    sendRemoteOverlay({ active: true, session: remoteSession });
    remoteOverlayWindow.showInactive();
  });
  remoteOverlayWindow.on('closed', () => { remoteOverlayWindow = null; });
  remoteOverlayWindow.loadFile(REMOTE_OVERLAY_FILE);
}

function syncRemoteOverlay(cursor = null, action = '') {
  if (!remoteSession) {
    if (remoteOverlayWindow && !remoteOverlayWindow.isDestroyed()) remoteOverlayWindow.hide();
    emit('remote', { version: '1.1 Beta', request: remoteRequest, session: null, enabled: settings.remoteRequests !== false });
    return;
  }
  if (!remoteOverlayWindow || remoteOverlayWindow.isDestroyed()) createRemoteOverlay();
  if (!remoteOverlayWindow || remoteOverlayWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  remoteOverlayWindow.setBounds(display.bounds, false);
  sendRemoteOverlay({ active: true, session: remoteSession, cursor, action });
  remoteOverlayWindow.showInactive();
  emit('remote', { version: '1.1 Beta', request: null, session: remoteSession, enabled: true });
}

async function stopRemoteSession({ notifyServer = true } = {}) {
  const sessionId = remoteSession?.id || '';
  remoteSession = null;
  remoteRequest = null;
  syncRemoteOverlay();
  if (notifyServer && token && sessionId) {
    try { await apiJson('/desk/remote/end', { method: 'POST', auth: true, body: { sessionId } }); } catch { /* local emergency stop always wins */ }
  }
  return { ok: true };
}

function recordAction(tool, status, summary, chatId = '') {
  const entry = { id: id('log-'), ts: Date.now(), tool, status, summary: String(summary).slice(0, 2_000), chatId };
  actionLog.push(entry);
  if (actionLog.length > MAX_ACTION_LOG) actionLog = actionLog.slice(-MAX_ACTION_LOG);
  saveActionLog();
  emit('action-log', { entry: publicLog(entry), logs: actionLog.slice(-100).reverse().map(publicLog) });
  syncAgentTasks();
  return entry;
}

function updateAction(entry, status, summary) {
  if (!entry) return;
  entry.status = status;
  entry.summary = String(summary || entry.summary).slice(0, 2_000);
  saveActionLog();
  emit('action-log', { entry: publicLog(entry), logs: actionLog.slice(-100).reverse().map(publicLog) });
  syncAgentTasks();
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

function isNewerVersion(candidate, current) {
  const a = String(candidate || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = String(current || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
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
    list: 'Просмотр папки', read: 'Чтение файла', write: 'Изменение файла', shell: 'Команда системы',
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
      ? `Действие будет выполнено в активном приложении ${process.platform === 'win32' ? 'Windows' : 'Linux'}.`
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

function linuxKey(key) {
  const map = {
    ENTER: 'Return', TAB: 'Tab', ESC: 'Escape', BACKSPACE: 'BackSpace',
    UP: 'Up', DOWN: 'Down', LEFT: 'Left', RIGHT: 'Right',
    'CTRL+A': 'ctrl+a', 'CTRL+C': 'ctrl+c', 'CTRL+V': 'ctrl+v', 'CTRL+S': 'ctrl+s', 'ALT+TAB': 'alt+Tab',
  };
  return map[key] || key;
}

function runLinuxInput(action, display) {
  const common = { timeoutSeconds: 20, command: '[Linux input action]' };
  if (action.tool === 'click') {
    return runChild('xdotool', ['mousemove', '--sync', String(display.bounds.x + action.x), String(display.bounds.y + action.y), 'click', '1'], common);
  }
  if (action.tool === 'type') {
    return runChild('xdotool', ['type', '--clearmodifiers', '--delay', '1', '--', action.text], common);
  }
  return runChild('xdotool', ['key', '--clearmodifiers', linuxKey(action.key)], common);
}

function runScreenInput(action, display) {
  if (process.platform !== 'win32') return runLinuxInput(action, display);
  if (action.tool === 'click') return runPowerShell(clickScript(display.bounds.x + action.x, display.bounds.y + action.y));
  if (action.tool === 'type') return runPowerShell(typeScript(action.text));
  return runPowerShell(keyScript(action.key));
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

function remoteClickScript(x, y) {
  // The orange overlay shows the AI pointer. Restore the person's pointer after
  // the click so Remote does not steal their mouse position.
  return `Add-Type -TypeDefinition @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class ClopRemoteMouse {\n [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }\n [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);\n [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);\n [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);\n}\n'@\n$old = New-Object ClopRemoteMouse+POINT\n[ClopRemoteMouse]::GetCursorPos([ref]$old) | Out-Null\n[ClopRemoteMouse]::SetCursorPos(${x}, ${y}) | Out-Null\n[ClopRemoteMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)\nStart-Sleep -Milliseconds 45\n[ClopRemoteMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)\nStart-Sleep -Milliseconds 55\n[ClopRemoteMouse]::SetCursorPos($old.X, $old.Y) | Out-Null`;
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
  let logEntry = null;
  try {
    if (['list', 'read', 'write'].includes(tool)) target = resolveForMode(action.path);
    await authorize(tool, action, target);
    const detail = actionEventDetail(action, target);
    emit('action', { status: 'running', tool, path: action.path || '', detail, chatId });
    logEntry = recordAction(tool, 'running', detail || tool, chatId);
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
      const result = await runScreenInput(action, display);
      outcome = { result: { ok: result.ok, tool, x: action.x, y: action.y } };
    } else if (tool === 'type') {
      const result = await runScreenInput(action, screen.getPrimaryDisplay());
      outcome = { result: { ok: result.ok, tool, characters: action.text.length } };
    } else if (tool === 'key') {
      const result = await runScreenInput(action, screen.getPrimaryDisplay());
      outcome = { result: { ok: result.ok, tool, key: action.key } };
    } else {
      throw new Error('Неизвестное действие.');
    }
    const outcomeStatus = outcome.result?.ok === false ? 'error' : 'done';
    if (outcomeStatus === 'error') logQuality('tool-result-error', { chatId, action: JSON.stringify(action), error: outcome.result?.error || 'tool returned ok=false' });
    updateAction(logEntry, outcomeStatus, target?.abs || action.command || detail || `${tool}`);
    emit('action', { status: outcomeStatus, tool, detail, chatId, result: outcome.result, error: outcome.result?.error });
    return outcome;
  } catch (error) {
    const status = error.message.includes('отклонено') ? 'denied' : 'error';
    if (logEntry) updateAction(logEntry, status, error.message);
    else recordAction(tool, status, target?.abs || action.path || action.command || tool, chatId);
    emit('action', { status: 'error', tool, detail: actionEventDetail(action, target), chatId, error: error.message });
    logQuality('tool-exception', { chatId, action: JSON.stringify(action), error: error.message });
    return { result: { ok: false, tool, error: error.message } };
  }
}

function toolProtocol(userText) {
  const location = settings.workDir || (accessMode === 'full' ? os.homedir() : 'не выбрана');
  const platformName = process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : process.platform;
  return `<clop_protocol>\nROLE: You are the execution engine inside the Clop Code desktop application on ${platformName}. You are not a web chat and you are not merely advising the user. The desktop application executes every clop_action you emit on the user's computer.\nACCESS: mode=${accessMode}; active working directory=${location}. In workspace mode, the active directory is the user's current project and is the default target. Do not ask the user to upload or resend files that you can inspect with list/read. Do not claim that the source task is missing before inspecting the active directory and relevant chat context.\nBEHAVIOR: For any clear request to create, change, fix, optimize, install, open, run, or test something, start doing it immediately. Inspect the project, make the required edits, run suitable checks, fix failures, and continue autonomously until the requested result exists on the computer. Prefer the most reasonable implementation from the current project and conversation. Ask one concise question only if two materially different targets remain after inspection and choosing one would risk destructive work. Never answer a computer task with plans, sample code, save-it-yourself instructions, a paraphrase of the request, or filler.\nACTIONS: Reply with exactly one XML block containing valid JSON whenever the next computer step is needed: <clop_action>{"tool":"list","path":"."}</clop_action>. Available tools: list {path}, read {path}, write {path,content}, shell {command}, screenshot {}, click {x,y}, type {text}, key {key}. Allowed keys: ENTER, TAB, ESC, BACKSPACE, UP, DOWN, LEFT, RIGHT, CTRL+A, CTRL+C, CTRL+V, CTRL+S, ALT+TAB. Paths may be absolute only in full mode. Use one action per turn, wait for its clop_result, then request the next action. Use write for files instead of printing their contents in chat. Never claim success before successful results and verification.\nFINISH: When the work is complete, return only a short Russian result: what was completed, the exact changed path(s), and the verification result. In chat mode, state briefly that the user must switch to Folder or Full mode because tools are disabled.\n</clop_protocol>\n<user_request>${JSON.stringify(userText)}</user_request>`;
}

function initialWorkspaceContext(userText) {
  if (accessMode === 'chat' || !requiresComputerAction(userText)) return '';
  let directory = settings.workDir;
  if (accessMode === 'full') {
    const explicit = /["«']([a-z]:\\[^"»'\r\n]+)["»']/iu.exec(String(userText || ''))?.[1];
    if (explicit && fs.existsSync(explicit) && fs.statSync(explicit).isDirectory()) directory = explicit;
  }
  if (!directory || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return '';
  try {
    const inventory = listDirectorySync(directory, '.');
    return `\n<clop_workspace_snapshot>${JSON.stringify({ directory, inventory })}</clop_workspace_snapshot>\nThe desktop app has already inspected the task's project directory. Use this real inventory, then read the relevant files and perform every requested change. Do not ask the user what to change.`;
  } catch {
    return '';
  }
}

function takeHints(run) {
  const hints = Array.isArray(run?.hints) ? run.hints.splice(0) : [];
  return hints.map((item) => String(item.text || '').trim()).filter(Boolean);
}

function hintPrompt(hints, previous = '') {
  return `<clop_hint>Пользователь добавил уточнение во время выполнения. Немедленно учти его в текущей задаче: ${JSON.stringify(hints.join('\n'))}. ${previous ? `Черновик предыдущего шага: ${JSON.stringify(String(previous).slice(0, 20_000))}` : ''}</clop_hint>`;
}

function addRunHint(payload = {}) {
  if (!currentRun) throw new Error('Сейчас нет активного ответа. Сообщение оставлено в очереди.');
  const text = String(payload.text || '').trim();
  if (!text) throw new Error('Подсказка пустая.');
  if (text.length > 20_000) throw new Error('Подсказка слишком длинная.');
  if (payload.chatId && payload.chatId !== currentRun.chatId) throw new Error('Подсказка относится к другому чату.');
  const chat = chats.find((item) => item.id === currentRun.chatId);
  if (!chat) throw new Error('Активный чат не найден.');
  const message = { role: 'user', content: text, ts: Date.now(), clientMessageId: id('hint-'), hint: true };
  currentRun.hints.push({ text, ts: message.ts });
  chat.messages.push(message);
  chat.messages = chat.messages.slice(-MAX_HISTORY_MESSAGES);
  chat.updatedAt = Date.now();
  saveHistory();
  emit('message', { chatId: chat.id, message, chat });
  emit('hint', { chatId: chat.id, count: currentRun.hints.length });
  recordAction('thinking', 'running', 'Получил подсказку пользователя', chat.id);
  return { ok: true, message };
}

function actionRecoveryPrompt(userText, attempt, rejectedReply = '') {
  return `<clop_protocol_reminder attempt="${attempt}">You are still inside Clop Code with working computer tools. The user's message already contains the task. Your previous reply is discarded without charging the user${isUnnecessaryClarification(userText, rejectedReply) ? ' because it asked the user to repeat requirements that were already provided' : ''}. Do not repeat it, explain it, ask what to change, ask for files already present, or return code in chat. Treat every concrete requirement in the original message as accepted work. Continue immediately with exactly one clop_action. If you have not inspected the active project, use list on "." now, then read the relevant files; otherwise perform the next write or shell step. Continue through verification before a brief final result. Original request: ${JSON.stringify(String(userText || ''))}</clop_protocol_reminder>`;
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
  const run = { controller, chatId: chat.id, stopped: false, startedAt: Date.now(), hints: [] };
  currentRun = run;
  emit('busy', { value: true, chatId: chat.id, startedAt: run.startedAt });
  syncAgentTasks();
  let sentAttachments = [];
  const runStartedAt = run.startedAt;
  try {
    const prepared = await readSelectedAttachments(attachmentIds);
    sentAttachments = prepared.chosen;
    let nextText = toolProtocol(text || 'Проанализируй выбранное вложение.');
    nextText += initialWorkspaceContext(text);
    let nextImages = prepared.images;
    let nextOffice = prepared.office;
    let finalReply = null;
    let runTokens = null;
    let modelDurationMs = 0;
    let completedSteps = 0;
    let actionRecoveryAttempts = 0;
    let successfulComputerActions = 0;
    const writtenPaths = [];
    for (let step = 0; step < MAX_AUTONOMOUS_ACTIONS; step += 1) {
      if (controller.signal.aborted) throw makeAbortError();
      const queuedHints = takeHints(run);
      if (queuedHints.length) nextText = `${nextText}\n\n${hintPrompt(queuedHints)}`;
      emit('step', { chatId: chat.id, step: step + 1 });
      const thinkingDetail = step ? 'Анализирует результат действия' : 'Анализирует запрос';
      const thinking = recordAction('thinking', 'running', thinkingDetail, chat.id);
      emit('action', { status: 'running', tool: 'thinking', detail: thinkingDetail, chatId: chat.id });
      let response;
      try {
        response = await chatStream({
          text: nextText,
          clientMessageId: `${clientMessageId}:${step + 1}`,
          model: selected.model,
          chatId: chat.remoteChatId || undefined,
          effort: selected.effort,
          fast: selected.fast,
          ...(nextImages?.length ? { images: nextImages } : {}),
          ...(nextOffice ? { office: nextOffice } : {}),
        }, controller.signal);
        updateAction(thinking, 'done', 'Ответ модели получен');
        emit('action', { status: 'done', tool: 'thinking', detail: 'Ответ модели получен', chatId: chat.id });
      } catch (error) {
        updateAction(thinking, 'error', error.message);
        emit('action', { status: 'error', tool: 'thinking', detail: thinkingDetail, chatId: chat.id, error: error.message });
        throw error;
      }
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
        logQuality('malformed-model-action', { chatId: chat.id, request: text, response: response.text, error: error.message });
        throw new Error(`Ответ модели остановлен: ${error.message}`);
      }
      const arrivedHints = takeHints(run);
      if (arrivedHints.length) {
        nextText = hintPrompt(arrivedHints, response.text);
        nextImages = [];
        nextOffice = undefined;
        continue;
      }
      if (!action) {
        const unfinishedComputerTask = accessMode !== 'chat'
          && requiresComputerAction(text)
          && (successfulComputerActions === 0 || isUnnecessaryClarification(text, response.text));
        if (unfinishedComputerTask) {
          logQuality('no-action-for-computer-task', { chatId: chat.id, request: text, response: response.text });
          if (actionRecoveryAttempts < 4) {
            actionRecoveryAttempts += 1;
            nextText = actionRecoveryPrompt(text, actionRecoveryAttempts, response.text);
            nextImages = [];
            nextOffice = undefined;
            emit('action', {
              status: 'running',
              tool: 'thinking',
              chatId: chat.id,
              detail: 'Модель не выполнила действие — Clop автоматически продолжает задачу без списания этого ответа',
            });
            continue;
          }
          throw new Error('Модель не выполнила ни одного действия. Лимит за пустые ответы не списан — повторите запрос.');
        }
        if (needsActionRecovery(text, response.text)) {
          logQuality('code-delivered-instead-of-action', { chatId: chat.id, request: text, response: response.text });
          // Файл уже реально записан предыдущим действием. В этом случае не
          // запускаем повторную запись только из-за того, что модель решила
          // продублировать код в финальном сообщении: ниже код будет скрыт, а
          // пользователю останется подтверждение с точным путём.
          if (writtenPaths.length) {
            finalReply = response;
            break;
          }
          if (accessMode === 'chat') {
            finalReply = {
              ...response,
              text: 'Для создания файла на компьютере переключитесь в режим «Папка» или «Полный». Код в чат не отправлен.',
            };
            break;
          }
          if (actionRecoveryAttempts < 4) {
            actionRecoveryAttempts += 1;
            nextText = actionRecoveryPrompt(text, actionRecoveryAttempts, response.text);
            nextImages = [];
            nextOffice = undefined;
            emit('action', {
              status: 'running',
              tool: 'write',
              chatId: chat.id,
              detail: 'Модель вернула код вместо файла — Clop продолжает создание на компьютере',
            });
            continue;
          }
          const fallback = codeFallbackAction(text, response.text);
          if (fallback) {
            const fallbackOutcome = await executeAction(fallback, chat.id);
            if (fallbackOutcome.result?.ok && fallbackOutcome.result.path) writtenPaths.push(fallbackOutcome.result.path);
            nextText = modelResult(fallbackOutcome.result);
            nextImages = [];
            nextOffice = undefined;
            continue;
          }
        }
        finalReply = response;
        break;
      }
      const outcome = await executeAction(action, chat.id);
      if (outcome.result?.ok && action.tool !== 'list' && action.tool !== 'read' && action.tool !== 'screenshot') {
        successfulComputerActions += 1;
      }
      if (action.tool === 'write' && outcome.result?.ok && outcome.result.path) writtenPaths.push(outcome.result.path);
      nextText = modelResult(outcome.result);
      nextImages = outcome.images || [];
      nextOffice = undefined;
    }
    if (!finalReply) {
      logQuality('agent-loop-limit', { chatId: chat.id, request: text, error: 'maximum autonomous actions reached' });
      throw new Error('Задача зациклилась и была безопасно остановлена. Уточните запрос и продолжите.');
    }
    const extractedReply = extractResponseFiles(finalReply);
    const persistedReply = await persistResponseFiles(extractedReply.files, controller.signal);
    let content = extractedReply.text.trim();
    if (writtenPaths.length && looksLikeCodeDelivery(content)) content = 'Готово — файлы созданы на компьютере.';
    if (writtenPaths.length) {
      const uniquePaths = [...new Set(writtenPaths)];
      const missingPaths = uniquePaths.filter((createdPath) => !content.includes(createdPath));
      if (missingPaths.length) content = `${content || 'Готово.'}\n\nСоздано на компьютере:\n${missingPaths.map((createdPath) => `• ${createdPath}`).join('\n')}`;
    }
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
    logQuality('request-failed', { chatId: chat.id, request: text, error: error.message });
    throw error;
  } finally {
    for (const item of sentAttachments) attachments.delete(item.id);
    if (currentRun === run) currentRun = null;
    emit('busy', { value: false, chatId: chat.id });
    syncAgentTasks();
    emit('attachments', { attachments: [...attachments.values()].map(publicAttachment) });
  }
}

function remoteProtocol(userText) {
  const display = screen.getPrimaryDisplay();
  return `<clop_remote_protocol version="1.1-beta">\nROLE: You control the user's visible Windows screen during a time-limited Clop Remote session that the user approved on the computer.\nSCREEN: width=${display.bounds.width}; height=${display.bounds.height}. Start with screenshot and inspect the returned image before clicking.\nACTIONS: Reply with exactly one XML block containing valid JSON for the next step: <clop_action>{"tool":"screenshot"}</clop_action>. Available tools are screenshot {}, click {x,y}, type {text}, key {key}. Allowed keys: ENTER, TAB, ESC, BACKSPACE, UP, DOWN, LEFT, RIGHT, CTRL+A, CTRL+C, CTRL+V, CTRL+S, ALT+TAB. Do not request files, shell commands, secrets, passwords, payment data, account recovery, security settings, or elevated/system actions. Use one action per turn, wait for the result, then continue. Stop when the requested visible task is complete and briefly report what you did.\nUSER TASK: ${JSON.stringify(String(userText || ''))}\n</clop_remote_protocol>`;
}

async function executeRemoteScreenAction(action, chatId = '') {
  if (!remoteSession || remoteSession.expiresAt <= Date.now()) throw new Error('Сеанс Clop Remote завершён.');
  if (!['screenshot', 'click', 'type', 'key'].includes(action.tool)) throw new Error('Clop Remote разрешает только экран, мышь и клавиатуру.');
  const display = screen.getPrimaryDisplay();
  const detail = actionEventDetail(action, null);
  const logEntry = recordAction(`remote-${action.tool}`, 'running', detail, chatId);
  emit('action', { status: 'running', tool: action.tool, detail, chatId, remote: true });
  try {
    let outcome;
    if (action.tool === 'screenshot') {
      outcome = await screenshotTool();
    } else if (action.tool === 'click') {
      if (action.x >= display.bounds.width || action.y >= display.bounds.height) throw new Error('Координаты находятся за пределами экрана.');
      syncRemoteOverlay({ x: action.x, y: action.y }, 'Нажатие');
      const result = process.platform === 'win32'
        ? await runPowerShell(remoteClickScript(display.bounds.x + action.x, display.bounds.y + action.y))
        : await runScreenInput(action, display);
      outcome = { result: { ok: result.ok, tool: action.tool, x: action.x, y: action.y } };
    } else {
      syncRemoteOverlay(null, action.tool === 'type' ? 'Ввод текста' : `Клавиша ${action.key}`);
      const result = await runScreenInput(action, display);
      outcome = { result: { ok: result.ok, tool: action.tool, ...(action.tool === 'type' ? { characters: action.text.length } : { key: action.key }) } };
    }
    updateAction(logEntry, outcome.result?.ok === false ? 'error' : 'done', detail);
    emit('action', { status: outcome.result?.ok === false ? 'error' : 'done', tool: action.tool, detail, chatId, remote: true });
    return outcome;
  } catch (error) {
    updateAction(logEntry, 'error', error.message);
    throw error;
  }
}

async function runRemotePrompt(text, commandId) {
  if (currentRun) throw new Error('Clop уже выполняет другую задачу.');
  await refreshAccount();
  const selected = validateChoice({});
  let chat = createChat();
  chat.title = `Remote: ${String(text).replace(/\s+/g, ' ').slice(0, 44)}`;
  const userMessage = { role: 'user', content: String(text), ts: Date.now(), clientMessageId: commandId, remote: true };
  chat.messages.push(userMessage);
  saveHistory();
  emit('message', { chatId: chat.id, message: userMessage, chat });
  const controller = new AbortController();
  const run = { controller, chatId: chat.id, stopped: false, startedAt: Date.now(), hints: [], remote: true };
  currentRun = run;
  emit('busy', { value: true, chatId: chat.id, startedAt: run.startedAt, remote: true });
  syncAgentTasks();
  let nextText = remoteProtocol(text);
  let nextImages = [];
  let finalText = '';
  try {
    for (let step = 0; step < 60; step += 1) {
      if (!remoteSession || remoteSession.expiresAt <= Date.now()) throw new Error('Сеанс Clop Remote завершён.');
      const response = await chatStream({
        text: nextText, clientMessageId: `${commandId}:${step + 1}`, model: selected.model,
        chatId: chat.remoteChatId || undefined, effort: selected.effort, fast: selected.fast,
        ...(nextImages.length ? { images: nextImages } : {}),
      }, controller.signal);
      if (response.chatId) chat.remoteChatId = response.chatId;
      const action = parseAction(response.text);
      if (!action) {
        finalText = String(response.text || 'Готово.').trim().slice(0, 20_000);
        break;
      }
      if (!['screenshot', 'click', 'type', 'key'].includes(action.tool)) throw new Error('ИИ запросил действие вне разрешений Remote.');
      const outcome = await executeRemoteScreenAction(action, chat.id);
      nextText = modelResult(outcome.result);
      nextImages = outcome.images || [];
    }
    if (!finalText) finalText = 'Задача остановлена: достигнут предел шагов Remote.';
    const assistant = { role: 'assistant', content: finalText, ts: Date.now(), model: selected.model, remote: true };
    chat.messages.push(assistant);
    chat.messages = chat.messages.slice(-MAX_HISTORY_MESSAGES);
    chat.updatedAt = Date.now();
    saveHistory();
    emit('message', { chatId: chat.id, message: assistant, chat });
    return finalText;
  } finally {
    if (currentRun === run) currentRun = null;
    emit('busy', { value: false, chatId: chat.id, remote: true });
    syncAgentTasks();
  }
}

async function reportRemoteResult(command, result) {
  if (!token || !remoteSession) return;
  await apiJson('/desk/remote/result', {
    method: 'POST', auth: true,
    body: { id: command.id, sessionId: remoteSession.id, ...result },
  });
}

async function processRemoteCommand(command) {
  if (remoteCommandBusy || !command || !remoteSession) return;
  remoteCommandBusy = true;
  try {
    if (command.type === 'stop') {
      await reportRemoteResult(command, { ok: true, text: 'Сеанс остановлен.' });
      await stopRemoteSession();
      return;
    }
    let result;
    if (command.type === 'prompt') {
      const text = await runRemotePrompt(command.payload?.text, command.id);
      result = { ok: true, text };
    } else {
      const action = { tool: command.type, ...(command.payload || {}) };
      const outcome = await executeRemoteScreenAction(action, `remote-${remoteSession.id}`);
      result = {
        ok: outcome.result?.ok !== false,
        x: outcome.result?.x, y: outcome.result?.y,
        text: outcome.result?.error || '',
        screen: outcome.images?.[0] || undefined,
      };
    }
    await reportRemoteResult(command, result);
  } catch (error) {
    try { await reportRemoteResult(command, { ok: false, error: error.message }); } catch { /* session may have expired */ }
    logQuality('remote-command-error', { action: JSON.stringify(command), error: error.message });
  } finally {
    remoteCommandBusy = false;
  }
}

async function pollRemote() {
  if (remotePolling || !token) return;
  remotePolling = true;
  try {
    const response = await apiJson('/desk/remote/heartbeat', {
      method: 'POST', auth: true,
      body: { name: `${os.hostname()} · ${process.platform}`, version: app.getVersion(), enabled: settings.remoteRequests !== false },
    });
    const incomingRequest = response.request || null;
    if (incomingRequest?.id && incomingRequest.id !== remoteRequest?.id) {
      remoteRequest = incomingRequest;
      showMainWindow();
      emit('remote-request', { request: incomingRequest, version: '1.1 Beta' });
    } else if (!incomingRequest) {
      remoteRequest = null;
    }
    const incomingSession = response.session || null;
    if (incomingSession?.id) {
      remoteSession = incomingSession;
      syncRemoteOverlay();
    } else if (remoteSession) {
      await stopRemoteSession({ notifyServer: false });
    }
    if (response.commands?.[0] && !remoteCommandBusy) processRemoteCommand(response.commands[0]);
  } catch (error) {
    if (!/нужен вход|401/i.test(String(error.message || ''))) emit('remote-network', { online: false });
  } finally {
    remotePolling = false;
  }
}

function startRemotePolling() {
  clearInterval(remotePollTimer);
  pollRemote();
  remotePollTimer = setInterval(pollRemote, 1_500);
  remotePollTimer.unref?.();
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
  const isAgentSender = (event) => [agentWindow, agentTasksWindow]
    .some((window) => window && !window.isDestroyed() && event.sender === window.webContents);
  ipcMain.on('agent-open-main', (event) => {
    if (!isAgentSender(event)) return;
    showMainWindow();
  });
  ipcMain.on('agent-menu', (event) => {
    if (!agentWindow || event.sender !== agentWindow.webContents) return;
    Menu.buildFromTemplate([
      { label: 'Открыть Clop Code', click: showMainWindow },
      { label: 'Открыть журнал проблем ИИ', click: () => { if (qualityLogFile) shell.showItemInFolder(qualityLogFile); } },
      { type: 'separator' },
      { label: 'Выйти', click: () => { isQuitting = true; app.quit(); } },
    ]).popup({ window: agentWindow });
  });
  ipcMain.on('agent-drag-start', (event, point = {}) => {
    if (!agentWindow || event.sender !== agentWindow.webContents) return;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    agentDrag = { point: { x: point.x, y: point.y }, bounds: agentWindow.getBounds() };
  });
  ipcMain.on('agent-drag-move', (event, point = {}) => {
    if (!agentWindow || event.sender !== agentWindow.webContents || !agentDrag) return;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const wanted = {
      x: Math.round(agentDrag.bounds.x + point.x - agentDrag.point.x),
      y: Math.round(agentDrag.bounds.y + point.y - agentDrag.point.y),
    };
    const display = screen.getDisplayNearestPoint({ x: wanted.x + 58, y: wanted.y + 58 });
    const area = display.workArea;
    agentWindow.setPosition(
      Math.max(area.x, Math.min(area.x + area.width - 116, wanted.x)),
      Math.max(area.y, Math.min(area.y + area.height - 116, wanted.y)),
      false,
    );
    positionAgentTasks();
  });
  ipcMain.on('agent-drag-end', (event) => {
    if (!agentWindow || event.sender !== agentWindow.webContents || !agentDrag) return;
    agentDrag = null;
    const [x, y] = agentWindow.getPosition();
    settings = cleanSettings({ agentPosition: { x, y } }, settings);
    saveSettings();
  });
  ipcMain.handle('agent-state', (event) => {
    if (!agentWindow || event.sender !== agentWindow.webContents) throw new Error('Недоверенный источник IPC.');
    return { online: agentOnline };
  });
  handle('remote-decision', async (payload = {}) => {
    ensureAuthenticated();
    if (!remoteRequest || remoteRequest.id !== String(payload.requestId || '')) throw new Error('Запрос Remote уже истёк.');
    const result = await apiJson('/desk/remote/decision', {
      method: 'POST', auth: true,
      body: { requestId: remoteRequest.id, allow: payload.allow === true },
    });
    remoteRequest = null;
    remoteSession = result.session || null;
    if (remoteSession) syncRemoteOverlay(); else syncRemoteOverlay();
    emit('remote', { version: '1.1 Beta', request: null, session: remoteSession, enabled: settings.remoteRequests !== false });
    return { ok: true, session: remoteSession, denied: result.denied === true };
  });
  handle('remote-stop', async () => stopRemoteSession());
  handle('hint', async (payload = {}) => addRunHint(payload));
  handle('update-check', async () => {
    const releases = await apiJson('/releases.json');
    const release = releases?.desktop;
    const current = app.getVersion();
    const url = process.platform === 'linux' ? release?.linuxUrl : (release?.windowsUrl || release?.url);
    return { available: Boolean(release?.version && url && isNewerVersion(release.version, current)), current, version: release?.version || current };
  });
  handle('update-install', async () => {
    const releases = await apiJson('/releases.json');
    const release = releases?.desktop;
    const isLinux = process.platform === 'linux';
    const url = isLinux ? release?.linuxUrl : (release?.windowsUrl || release?.url);
    const expectedPrefix = isLinux ? `${SERVER}/downloads/Clop-Code-` : `${SERVER}/downloads/Clop-Code-Setup-`;
    const expectedSuffix = isLinux ? '.tar.xz' : '.exe';
    if (!url?.startsWith(expectedPrefix) || !url.endsWith(expectedSuffix)) throw new Error('Сервер обновлений вернул неверный адрес.');
    const response = await fetchWithTimeout(url, {}, 10 * 60 * 1000);
    if (!response.ok || !response.body) throw new Error('Не удалось скачать обновление.');
    const file = path.join(isLinux ? app.getPath('downloads') : app.getPath('temp'), isLinux
      ? `Clop-Code-${release.version}-linux-x64.tar.xz`
      : `Clop-Code-Setup-${release.version}.exe`);
    const totalBytes = Math.max(0, Number(response.headers.get('content-length')) || 0);
    let receivedBytes = 0;
    let lastEmitAt = 0;
    const startedAt = Date.now();
    emit('update-progress', { phase: 'downloading', receivedBytes, totalBytes, speedBytesPerSecond: 0, etaSeconds: null, percent: 0 });
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        const now = Date.now();
        if (now - lastEmitAt >= 180 || (totalBytes && receivedBytes >= totalBytes)) {
          lastEmitAt = now;
          const elapsedSeconds = Math.max(0.2, (now - startedAt) / 1_000);
          const speedBytesPerSecond = receivedBytes / elapsedSeconds;
          const etaSeconds = totalBytes && speedBytesPerSecond > 0 ? Math.max(0, (totalBytes - receivedBytes) / speedBytesPerSecond) : null;
          const percent = totalBytes ? Math.min(100, receivedBytes / totalBytes * 100) : 0;
          emit('update-progress', { phase: 'downloading', receivedBytes, totalBytes, speedBytesPerSecond, etaSeconds, percent });
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(file));
    } catch (error) {
      try { fs.unlinkSync(file); } catch {}
      emit('update-progress', { phase: 'error' });
      throw error;
    }
    emit('update-progress', { phase: isLinux ? 'downloaded' : 'installing', receivedBytes, totalBytes: totalBytes || receivedBytes,
      speedBytesPerSecond: 0, etaSeconds: 0, percent: 100 });
    if (isLinux) {
      shell.showItemInFolder(file);
      return { ok: true, downloaded: true, file };
    }
    launchWindowsUpdate({
      installerPath: file,
      installDir: path.dirname(process.execPath),
      appPath: process.execPath,
      tempDir: app.getPath('temp'),
      logPath: path.join(dataDir, 'update.log'),
      parentPid: process.pid,
    });
    isQuitting = true;
    await stopEverything();
    clearInterval(agentCursorTimer);
    clearInterval(agentNetworkTimer);
    setTimeout(() => {
      if (agentTasksWindow && !agentTasksWindow.isDestroyed()) agentTasksWindow.destroy();
      if (agentWindow && !agentWindow.isDestroyed()) agentWindow.destroy();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      app.exit(0);
    }, 150);
    return { ok: true };
  });
  handle('state', async () => {
    if (token) {
      try { await refreshAccount(true); } catch { /* state remains usable offline */ }
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
    if (Object.hasOwn(patch, 'agentVisible')) syncAgentVisibility();
    if (Object.hasOwn(patch, 'remoteRequests') && settings.remoteRequests === false) await stopRemoteSession();
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
  handle('bugs', async () => {
    ensureAuthenticated();
    return apiJson('/desk/bugs', { auth: true });
  });
  handle('bug-submit', async (payload = {}) => {
    ensureAuthenticated();
    const description = String(payload.description || '').trim();
    if (description.length < 5) throw new Error('Опишите проблему хотя бы в нескольких словах.');
    return apiJson('/desk/bugs', { method: 'POST', auth: true, body: { description } });
  });
  handle('logout', async () => {
    if (token) {
      try { await apiJson('/desk/logout', { method: 'POST', auth: true }); } catch { /* local logout must still work */ }
    }
    clearToken();
    pendingLogin = null;
    await stopRemoteSession({ notifyServer: false });
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
  mainWindow.on('close', (event) => {
    if (!isQuitting && !SMOKE_TEST && settings.agentVisible !== false) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    stopEverything();
    mainWindow = null;
    if (settings.agentVisible === false) {
      if (agentWindow && !agentWindow.isDestroyed()) agentWindow.destroy();
      if (agentTasksWindow && !agentTasksWindow.isDestroyed()) agentTasksWindow.destroy();
      app.quit();
    }
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
    createAgentWindow();
    startRemotePolling();
    globalShortcut.register('CommandOrControl+Alt+F9', () => { stopRemoteSession(); });
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
  app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(false);
  });
  app.on('window-all-closed', () => { if (SMOKE_TEST || settings.agentVisible === false) app.quit(); });
  app.on('before-quit', () => {
    isQuitting = true;
    clearInterval(agentCursorTimer);
    clearInterval(agentNetworkTimer);
    clearInterval(remotePollTimer);
    globalShortcut.unregisterAll();
    if (remoteOverlayWindow && !remoteOverlayWindow.isDestroyed()) remoteOverlayWindow.destroy();
    if (agentTasksWindow && !agentTasksWindow.isDestroyed()) agentTasksWindow.destroy();
    rejectAllApprovals();
    stopChild();
  });
}
