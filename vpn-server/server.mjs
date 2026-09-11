import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { addCounters, planFor, resetPeriod, WEEK_MS } from './plans.mjs';

const exec = promisify(execFile);
const PORT = Number(process.env.PORT || 8790);
const DATA_DIR = process.env.DATA_DIR || '/data';
const IFACE = process.env.WG_INTERFACE || 'wg0';
const ENDPOINT = process.env.VPN_PUBLIC_ENDPOINT || '195.201.169.74:51820';
const SECRET = String(process.env.VPN_CONTROL_SECRET || '');
const STATE_FILE = path.join(DATA_DIR, 'peers.json');
const PUBLIC_KEY_FILE = path.join(DATA_DIR, 'server.pub');
const PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
let state = { version: 1, nextHost: 2, peers: {} };
let updateBusy = false;

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (parsed && parsed.peers && typeof parsed.peers === 'object') state = parsed;
  } catch {}
}

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, STATE_FILE);
}

async function command(file, args, ignore = false) {
  try { return await exec(file, args, { timeout: 8_000, maxBuffer: 2_000_000 }); }
  catch (error) { if (ignore) return { stdout: '', stderr: String(error?.stderr || error?.message || error) }; throw error; }
}

function hostNumber(address) {
  const [, third, fourth] = String(address).match(/^10\.77\.(\d{1,3})\.(\d{1,3})$/) || [];
  return Number(third) * 256 + Number(fourth);
}

function addressFor(host) {
  return `10.77.${Math.floor(host / 256)}.${host % 256}`;
}

function allocateAddress() {
  const used = new Set(Object.values(state.peers).map((peer) => peer.address));
  for (let tries = 0; tries < 65_000; tries += 1) {
    const host = Math.max(2, Number(state.nextHost) || 2);
    state.nextHost = host >= 65_534 ? 2 : host + 1;
    const address = addressFor(host);
    if (!used.has(address)) return address;
  }
  throw new Error('Свободные VPN-адреса закончились.');
}

async function setQos(peer) {
  const plan = planFor(peer.plan);
  const classId = Math.max(10, Math.min(65_534, hostNumber(peer.address) + 10));
  const prio = classId;
  await command('tc', ['class', 'replace', 'dev', IFACE, 'parent', '1:', 'classid', `1:${classId}`, 'htb', 'rate', `${plan.speedMbps}mbit`, 'ceil', `${plan.speedMbps}mbit`]);
  await command('tc', ['filter', 'replace', 'dev', IFACE, 'protocol', 'ip', 'parent', '1:', 'prio', String(prio), 'u32', 'match', 'ip', 'dst', `${peer.address}/32`, 'flowid', `1:${classId}`]);
  await command('tc', ['filter', 'replace', 'dev', IFACE, 'parent', 'ffff:', 'protocol', 'ip', 'prio', String(prio), 'u32', 'match', 'ip', 'src', `${peer.address}/32`, 'police', 'rate', `${plan.speedMbps}mbit`, 'burst', '2mb', 'drop', 'flowid', ':1']);
}

async function clearQos(peer) {
  const classId = Math.max(10, Math.min(65_534, hostNumber(peer.address) + 10));
  await command('tc', ['filter', 'del', 'dev', IFACE, 'protocol', 'ip', 'parent', '1:', 'prio', String(classId)], true);
  await command('tc', ['filter', 'del', 'dev', IFACE, 'parent', 'ffff:', 'protocol', 'ip', 'prio', String(classId)], true);
  await command('tc', ['class', 'del', 'dev', IFACE, 'parent', '1:', 'classid', `1:${classId}`], true);
}

async function enablePeer(peer) {
  await command('wg', ['set', IFACE, 'peer', peer.publicKey, 'allowed-ips', `${peer.address}/32`]);
  await command('ip', ['route', 'replace', `${peer.address}/32`, 'dev', IFACE]);
  await setQos(peer);
  peer.disabled = false;
}

async function disablePeer(peer) {
  await command('wg', ['set', IFACE, 'peer', peer.publicKey, 'remove'], true);
  await command('ip', ['route', 'del', `${peer.address}/32`, 'dev', IFACE], true);
  await clearQos(peer);
  peer.disabled = true;
}

function publicPeer(peer, now = Date.now()) {
  const plan = planFor(peer.plan);
  const usedBytes = Number(peer.uploadBytes || 0) + Number(peer.downloadBytes || 0);
  const periodStartedAt = Number(peer.periodStartedAt || now);
  return {
    ok: true,
    location: { key: 'de', country: 'Германия', city: 'Фалькенштайн', flag: 'DE' },
    endpoint: ENDPOINT,
    serverPublicKey: fs.readFileSync(PUBLIC_KEY_FILE, 'utf8').trim(),
    address: `${peer.address}/32`,
    dns: ['1.1.1.1', '1.0.0.1'],
    plan,
    periodStartedAt,
    resetsAt: periodStartedAt + WEEK_MS,
    uploadBytes: Number(peer.uploadBytes || 0),
    downloadBytes: Number(peer.downloadBytes || 0),
    usedBytes,
    remainingBytes: Math.max(0, plan.weeklyBytes - usedBytes),
    usagePercent: Math.min(100, usedBytes / plan.weeklyBytes * 100),
    latestHandshakeAt: Number(peer.latestHandshakeAt || 0) * 1_000,
    endpointSeen: peer.endpointSeen || '',
    enabled: !peer.disabled && usedBytes < plan.weeklyBytes,
    exhausted: usedBytes >= plan.weeklyBytes,
  };
}

async function updateTraffic() {
  if (updateBusy) return;
  updateBusy = true;
  let changed = false;
  try {
    const now = Date.now();
    const byKey = new Map(Object.values(state.peers).map((peer) => [peer.publicKey, peer]));
    const { stdout } = await command('wg', ['show', IFACE, 'dump'], true);
    for (const line of String(stdout || '').trim().split('\n').slice(1)) {
      const [publicKey, , endpoint, , handshake, received, sent] = line.split('\t');
      const peer = byKey.get(publicKey);
      if (!peer) continue;
      addCounters(peer, received, sent);
      peer.latestHandshakeAt = Number(handshake || 0);
      peer.endpointSeen = endpoint || '';
      changed = true;
    }
    for (const peer of Object.values(state.peers)) {
      const reset = resetPeriod(peer, now);
      const plan = planFor(peer.plan);
      const exhausted = Number(peer.uploadBytes || 0) + Number(peer.downloadBytes || 0) >= plan.weeklyBytes;
      if (exhausted && !peer.disabled) { await disablePeer(peer); changed = true; }
      else if (reset) { await enablePeer(peer); changed = true; }
    }
    if (changed) saveState();
  } finally {
    updateBusy = false;
  }
}

async function restorePeers() {
  await command('tc', ['qdisc', 'replace', 'dev', IFACE, 'root', 'handle', '1:', 'htb', 'default', '1']);
  await command('tc', ['class', 'replace', 'dev', IFACE, 'parent', '1:', 'classid', '1:1', 'htb', 'rate', '10gbit', 'ceil', '10gbit']);
  await command('tc', ['qdisc', 'replace', 'dev', IFACE, 'handle', 'ffff:', 'ingress'], true);
  for (const peer of Object.values(state.peers)) {
    resetPeriod(peer);
    peer.lastReceivedBytes = 0;
    peer.lastSentBytes = 0;
    const exhausted = peer.uploadBytes + peer.downloadBytes >= planFor(peer.plan).weeklyBytes;
    if (exhausted) await disablePeer(peer); else await enablePeer(peer);
  }
  saveState();
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 50_000) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}

loadState();
await restorePeers();
setInterval(() => updateTraffic().catch((error) => console.error('[traffic]', error.message)), 5_000).unref();

http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://vpn-control');
  if (url.pathname === '/health') return json(res, 200, { ok: true, peers: Object.keys(state.peers).length, interface: IFACE });
  if (!SECRET || req.headers.authorization !== `Bearer ${SECRET}`) return json(res, 401, { ok: false, error: 'нет доступа' });
  try {
    await updateTraffic();
    const match = /^\/peers\/([^/]+)(?:\/status)?$/.exec(url.pathname);
    if (url.pathname === '/peers/upsert' && req.method === 'POST') {
      const body = await readBody(req);
      const userId = String(body.userId || '');
      const publicKey = String(body.publicKey || '');
      if (!/^\d{1,24}$/.test(userId)) return json(res, 400, { ok: false, error: 'некорректный пользователь' });
      if (!PUBLIC_KEY_RE.test(publicKey)) return json(res, 400, { ok: false, error: 'некорректный публичный ключ WireGuard' });
      const duplicate = Object.values(state.peers).find((candidate) => candidate.userId !== userId && candidate.publicKey === publicKey);
      if (duplicate) return json(res, 409, { ok: false, error: 'этот ключ уже привязан к другому аккаунту' });
      let peer = state.peers[userId];
      if (!peer) peer = state.peers[userId] = { userId, address: allocateAddress(), periodStartedAt: Date.now(), uploadBytes: 0, downloadBytes: 0 };
      if (peer.publicKey && peer.publicKey !== publicKey) await disablePeer(peer);
      peer.publicKey = publicKey;
      peer.displayName = String(body.displayName || '').slice(0, 120);
      peer.plan = planFor(body.plan).key;
      peer.updatedAt = Date.now();
      peer.lastReceivedBytes = 0;
      peer.lastSentBytes = 0;
      resetPeriod(peer);
      const exhausted = peer.uploadBytes + peer.downloadBytes >= planFor(peer.plan).weeklyBytes;
      if (exhausted) await disablePeer(peer); else await enablePeer(peer);
      saveState();
      return json(res, 200, publicPeer(peer));
    }
    if (match && req.method === 'GET') {
      const peer = state.peers[decodeURIComponent(match[1])];
      return peer ? json(res, 200, publicPeer(peer)) : json(res, 404, { ok: false, error: 'VPN-профиль ещё не создан' });
    }
    if (match && req.method === 'DELETE') {
      const id = decodeURIComponent(match[1]);
      const peer = state.peers[id];
      if (peer) { await disablePeer(peer); delete state.peers[id]; saveState(); }
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, error: 'маршрут не найден' });
  } catch (error) {
    console.error('[request]', error);
    return json(res, 500, { ok: false, error: 'VPN-сервис временно недоступен' });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`Clop VPN control listening on ${PORT}`));
