'use strict';
const api = window.clopVpn;
const $ = (id) => document.getElementById(id);
let state = null, login = null, pollTimer = null, previousSample = null, connectedSince = 0, toastTimer = null;

function humanBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1e12) return `${(value / 1e12).toFixed(value >= 10e12 ? 0 : 1)} ТБ`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(value >= 10e9 ? 0 : 1)} ГБ`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} МБ`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} КБ`;
  return `${Math.round(value)} Б`;
}
function remainingTime(timestamp) {
  const left = Math.max(0, Number(timestamp) - Date.now());
  const days = Math.floor(left / 86400000), hours = Math.floor(left % 86400000 / 3600000);
  return days ? `${days} дн. ${hours} ч.` : `${hours} ч. ${Math.max(1, Math.ceil(left / 60000)) % 60} мин.`;
}
function elapsed(since) {
  const sec = Math.floor((Date.now() - since) / 1000);
  return [Math.floor(sec / 3600), Math.floor(sec % 3600 / 60), sec % 60].map((v) => String(v).padStart(2, '0')).join(':');
}
function showToast(message, error = false) {
  const el = $('toast'); el.textContent = message; el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = 'toast'; }, 4200);
}

function render(next) {
  const now = performance.now(); state = next;
  $('loginModal').classList.toggle('hidden', next.loggedIn);
  $('accountName').textContent = next.account?.name || 'Clop'; $('accountPlan').textContent = next.account?.plan || 'Не выполнен вход';
  $('logout').style.visibility = next.loggedIn ? 'visible' : 'hidden';
  $('dependencyLabel').textContent = next.dependency?.label || 'Проверка WireGuard…';
  $('installDependency').classList.toggle('hidden', Boolean(next.dependency?.ready));
  $('connectButton').disabled = next.busy || !next.loggedIn || !next.dependency?.ready;
  $('connectionCard').classList.toggle('connected', next.connected);
  $('heroTitle').textContent = next.connected ? 'Ваш трафик защищён' : (next.busy ? 'Подключаем…' : 'Готов к подключению');
  $('connectionLabel').textContent = next.busy ? 'Подождите…' : (next.connected ? 'Отключить' : 'Подключить');
  if (next.connected && !connectedSince) connectedSince = Date.now();
  if (!next.connected) connectedSince = 0;
  $('connectionTime').textContent = next.connected ? elapsed(connectedSince) : 'Германия · Фалькенштайн';
  const p = next.profile;
  if (p) {
    $('usedTraffic').textContent = humanBytes(p.usedBytes); $('trafficLimit').textContent = `${p.plan.weeklyGb} ГБ`;
    $('usagePercent').textContent = `${Number(p.usagePercent || 0).toFixed(p.usagePercent < 1 ? 1 : 0)}% использовано`;
    $('usageBar').style.width = `${Math.min(100, Number(p.usagePercent || 0))}%`;
    $('speedLimit').textContent = p.plan.speedMbps; $('resetTime').textContent = remainingTime(p.resetsAt);
    const current = { at: now, down: Number(p.downloadBytes || 0), up: Number(p.uploadBytes || 0) };
    if (previousSample && next.connected && current.at > previousSample.at) {
      const seconds = (current.at - previousSample.at) / 1000;
      $('downloadSpeed').textContent = Math.max(0, (current.down - previousSample.down) * 8 / seconds / 1e6).toFixed(1);
      $('uploadSpeed').textContent = Math.max(0, (current.up - previousSample.up) * 8 / seconds / 1e6).toFixed(1);
    } else if (!next.connected) { $('downloadSpeed').textContent = '0.0'; $('uploadSpeed').textContent = '0.0'; }
    previousSample = current;
    $('latency').textContent = p.latestHandshakeAt && Date.now() - p.latestHandshakeAt < 180000 ? 'онлайн' : '— мс';
  } else {
    $('usedTraffic').textContent = '0 Б'; $('trafficLimit').textContent = '—'; $('usagePercent').textContent = '0% использовано';
    $('usageBar').style.width = '0%'; $('speedLimit').textContent = '—'; $('resetTime').textContent = 'после подключения'; previousSample = null;
  }
}

async function updateAfter(action, success) {
  try { await action(); render(await api.state()); if (success) showToast(success); }
  catch (error) { showToast(error.message || String(error), true); render(await api.state()); }
}
async function startLogin() {
  try {
    login = await api.login(); $('loginButton').classList.add('hidden'); $('loginWait').classList.remove('hidden'); $('cancelLogin').classList.remove('hidden');
    $('loginCode').textContent = login.code; schedulePoll(1800);
  } catch (error) { showToast(error.message || String(error), true); }
}
function schedulePoll(delay = 3000) { clearTimeout(pollTimer); pollTimer = setTimeout(pollLogin, delay); }
async function pollLogin() {
  if (!login) return;
  try {
    const result = await api.pollLogin({ id: login.id });
    if (result.status === 'complete') { login = null; render(result.state); showToast('Вход выполнен'); return; }
    if (result.status === 'expired') { await cancelLogin(); showToast('Код входа устарел.', true); return; }
  } catch (error) { showToast(error.message || String(error), true); }
  if (login) schedulePoll();
}
async function cancelLogin() {
  clearTimeout(pollTimer); login = null; await api.cancelLogin();
  $('loginButton').classList.remove('hidden'); $('loginWait').classList.add('hidden'); $('cancelLogin').classList.add('hidden');
}

$('minimize').addEventListener('click', () => api.window('minimize'));
$('close').addEventListener('click', () => api.window('close'));
$('loginButton').addEventListener('click', startLogin); $('cancelLogin').addEventListener('click', cancelLogin);
$('connectButton').addEventListener('click', () => updateAfter(() => state.connected ? api.disconnect() : api.connect(), state.connected ? 'VPN отключён' : 'VPN подключён'));
$('installDependency').addEventListener('click', () => updateAfter(() => api.installDependency(), 'Установка WireGuard запущена'));
$('logout').addEventListener('click', () => updateAfter(() => api.logout(), 'Вы вышли из аккаунта'));
api.onState(render);
api.state().then(render).catch((error) => showToast(error.message || String(error), true));
setInterval(() => api.refresh().then(render).catch(() => api.state().then(render).catch(() => {})), 5000);
setInterval(() => { if (state?.connected) $('connectionTime').textContent = elapsed(connectedSince); }, 1000);
