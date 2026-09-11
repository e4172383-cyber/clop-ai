'use strict';

const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveServer } = require('./server-config.cjs');
const tunnel = require('./tunnel.cjs');

const exec = promisify(execFile);
const SMOKE_TEST = process.argv.includes('--smoke-test');
const RENDERER = path.join(__dirname, 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, 'preload.cjs');
const ELEVATED_SOURCE = path.join(__dirname, 'elevated.ps1');
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'",
].join('; ');

let mainWindow = null;
let server = '';
let token = '';
let account = null;
let profile = null;
let pendingLogin = null;
let refreshTimer = null;
let dataDir = '';
let sessionFile = '';
let configPath = '';
let elevatedHelperPath = '';
let privateKey = '';
let publicKey = '';
let busy = false;

function emit(value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state-changed', value);
}

function encodeSecret(value) {
  if (safeStorage.isEncryptionAvailable()) return { encrypted: true, value: safeStorage.encryptString(value).toString('base64') };
  return { encrypted: false, value };
}

function decodeSecret(record) {
  if (!record?.value) return '';
  try { return record.encrypted ? safeStorage.decryptString(Buffer.from(record.value, 'base64')) : String(record.value); } catch { return ''; }
}

function saveSession() {
  const data = {
    token: token ? encodeSecret(token) : null,
    privateKey: privateKey ? encodeSecret(privateKey) : null,
    publicKey,
  };
  fs.writeFileSync(sessionFile, JSON.stringify(data), { mode: 0o600 });
}

function loadSession() {
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    token = decodeSecret(data.token);
    privateKey = decodeSecret(data.privateKey);
    publicKey = String(data.publicKey || '');
  } catch {}
}

function ensureKeys() {
  if (/^[A-Za-z0-9+/]{43}=$/.test(privateKey) && /^[A-Za-z0-9+/]{43}=$/.test(publicKey)) return;
  const pair = crypto.generateKeyPairSync('x25519');
  const privateDer = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  privateKey = Buffer.from(privateDer).subarray(-32).toString('base64');
  publicKey = Buffer.from(publicDer).subarray(-32).toString('base64');
  saveSession();
}

async function fetchJson(endpoint, { method = 'GET', body, auth = false, tolerate404 = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (auth) {
    if (!token) throw new Error('Войдите через Telegram.');
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  timer.unref?.();
  let response;
  try {
    response = await fetch(`${server}${endpoint}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
  } catch (error) {
    throw new Error(error?.name === 'AbortError' ? 'Сервер не ответил вовремя.' : 'Не удалось подключиться к серверу Clop.');
  } finally { clearTimeout(timer); }
  if (tolerate404 && response.status === 404) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    if (response.status === 401) { token = ''; account = null; profile = null; saveSession(); }
    throw new Error(result.error || `Сервер вернул ошибку ${response.status}.`);
  }
  return result;
}

async function refreshRemote() {
  if (!token) { account = null; profile = null; return; }
  account = await fetchJson('/desk/me', { auth: true });
  profile = await fetchJson('/desk/vpn/status', { auth: true, tolerate404: true });
}

async function publicState() {
  const dependency = await tunnel.dependencyState();
  const isConnected = await tunnel.connected();
  return {
    loggedIn: Boolean(token && account),
    account: account ? { name: account.name, plan: account.plan, planKey: account.planKey } : null,
    profile,
    connected: isConnected,
    dependency,
    busy,
    version: app.getVersion(),
    secureStorage: safeStorage.isEncryptionAvailable(),
  };
}

async function broadcast() {
  try { emit(await publicState()); } catch {}
}

async function refreshAndBroadcast() {
  try { await refreshRemote(); } catch (error) { if (!token) account = null; }
  await broadcast();
}

async function withBusy(action) {
  if (busy) throw new Error('Дождитесь завершения текущей операции.');
  busy = true;
  await broadcast();
  try { return await action(); }
  finally { busy = false; await broadcast(); }
}

function registerIpc() {
  const handle = (name, fn) => ipcMain.handle(name, async (_event, ...args) => fn(...args));
  handle('state', async () => {
    if (token && !account) await refreshRemote().catch(() => {});
    return publicState();
  });
  handle('refresh', async () => { await refreshRemote(); return publicState(); });
  handle('login', async () => {
    const code = crypto.randomBytes(8).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64url');
    const secretHash = crypto.createHash('sha256').update(secret).digest('base64url');
    const result = await fetchJson('/desk/init', { method: 'POST', body: { code, secretHash, device: `${os.hostname()} · ${process.platform} · Clop VPN ${app.getVersion()}` } });
    if (!result.ok) throw new Error('Не удалось создать вход через Telegram.');
    const bot = String(result.bot || '').replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!bot) throw new Error('Сервер не вернул Telegram-бота.');
    pendingLogin = { id: crypto.randomUUID(), code, secret, expiresAt: Date.now() + 10 * 60_000 };
    const url = `https://t.me/${bot}?start=desk_${encodeURIComponent(code)}`;
    await shell.openExternal(url, { activate: true }).catch(() => {});
    return { ok: true, id: pendingLogin.id, code, url, expiresAt: pendingLogin.expiresAt };
  });
  handle('login-poll', async (request = {}) => {
    if (!pendingLogin || request.id !== pendingLogin.id || Date.now() > pendingLogin.expiresAt) return { status: 'expired' };
    const result = await fetchJson('/desk/poll', { method: 'POST', body: { code: pendingLogin.code, secret: pendingLogin.secret } });
    if (result.pending || !result.token) return { status: 'pending' };
    token = String(result.token);
    pendingLogin = null;
    ensureKeys();
    saveSession();
    await refreshRemote();
    await broadcast();
    return { status: 'complete', state: await publicState() };
  });
  handle('login-cancel', async () => { pendingLogin = null; return { ok: true }; });
  handle('logout', async () => withBusy(async () => {
    if (await tunnel.connected()) await tunnel.disconnect(configPath, elevatedHelperPath);
    if (token) await fetchJson('/desk/logout', { method: 'POST', auth: true }).catch(() => {});
    token = ''; account = null; profile = null; pendingLogin = null;
    saveSession();
    return { ok: true };
  }));
  handle('connect', async () => withBusy(async () => {
    if (!token) throw new Error('Сначала войдите через Telegram.');
    ensureKeys();
    profile = await fetchJson('/desk/vpn/profile', { method: 'POST', auth: true, body: { publicKey } });
    if (profile.exhausted || !profile.enabled) throw new Error('Недельный трафик закончился. Подключение откроется после сброса лимита.');
    fs.writeFileSync(configPath, tunnel.profileText(privateKey, profile, { includeDns: process.platform === 'win32' }), { mode: 0o600 });
    if (!(await tunnel.connected())) await tunnel.connect(configPath, elevatedHelperPath);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await refreshRemote();
    return { ok: true };
  }));
  handle('disconnect', async () => withBusy(async () => {
    if (await tunnel.connected()) await tunnel.disconnect(configPath, elevatedHelperPath);
    await refreshRemote().catch(() => {});
    return { ok: true };
  }));
  handle('install-dependency', async () => withBusy(async () => {
    if (process.platform === 'win32') {
      if ((await tunnel.dependencyState()).ready) return { ok: true, installed: true };
      try {
        await exec('winget.exe', [
          'install', '--id', 'WireGuard.WireGuard', '--exact', '--silent',
          '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
        ], { timeout: 10 * 60_000, windowsHide: true });
      } catch {
        await shell.openExternal('https://www.wireguard.com/install/', { activate: true });
        throw new Error('Автоустановка не удалась. Открыта официальная страница WireGuard. Установите его и вернитесь в Clop VPN.');
      }
      if (!(await tunnel.dependencyState()).ready) throw new Error('WireGuard установлен, но пока не найден. Перезапустите Clop VPN.');
      return { ok: true, installed: true };
    }
    if (process.platform === 'linux') {
      await exec('pkexec', ['apt-get', 'install', '-y', 'wireguard-tools'], { timeout: 10 * 60_000 });
      return { ok: true };
    }
    throw new Error('Эта система пока не поддерживается.');
  }));
  handle('window', async (action) => {
    if (action === 'minimize') mainWindow?.minimize();
    else if (action === 'close') mainWindow?.close();
    return { ok: true };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 760, minWidth: 920, minHeight: 650, show: false, frame: false,
    backgroundColor: '#f2eee9', title: 'Clop VPN', autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: !app.isPackaged && !SMOKE_TEST },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== mainWindow.webContents.getURL()) event.preventDefault(); });
  mainWindow.once('ready-to-show', () => { if (!SMOKE_TEST) mainWindow.show(); });
  mainWindow.loadFile(RENDERER);
  if (SMOKE_TEST) {
    const finish = (code) => { mainWindow?.destroy(); app.exit(code); };
    mainWindow.webContents.once('did-finish-load', () => setTimeout(() => finish(0), 100));
    mainWindow.webContents.once('did-fail-load', () => finish(1));
    setTimeout(() => finish(1), 15_000).unref();
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.clop.vpn.desktop');
    dataDir = app.getPath('userData');
    fs.mkdirSync(dataDir, { recursive: true });
    sessionFile = path.join(dataDir, 'session.json');
    configPath = path.join(dataDir, `${tunnel.TUNNEL_NAME}.conf`);
    elevatedHelperPath = path.join(dataDir, 'clop-vpn-elevated.ps1');
    fs.writeFileSync(elevatedHelperPath, fs.readFileSync(ELEVATED_SOURCE, 'utf8'), { mode: 0o600 });
    loadSession();
    server = (await resolveServer()).url;
    registerIpc();
    createWindow();
    refreshTimer = setInterval(refreshAndBroadcast, 5_000);
    refreshTimer.unref?.();
  }).catch((error) => { console.error(error); app.exit(1); });
  app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => { event.preventDefault(); callback(false); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => clearInterval(refreshTimer));
}
