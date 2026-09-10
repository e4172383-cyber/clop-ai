import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WEEK_LIMIT_MS, normalizedRecord, quotaView, settleRecord } from './quota.js';

const PORT = Number(process.env.PORT || 9090);
const SECRET = process.env.VM_INTERNAL_SECRET || '';
const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'usage.json');
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const VM_IMAGE = process.env.VM_IMAGE || 'clop-vm-runtime:1';
const VM_MEMORY = 1536 * 1024 * 1024;
const VM_CPU = 2_000_000_000;
const MAX_BODY = 16_000;
const locks = new Set();

if (!SECRET) throw new Error('VM_INTERNAL_SECRET is required');
fs.mkdirSync(DATA_DIR, { recursive: true });
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { state = {}; }

function saveState() {
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, STATE_FILE);
}

function recordFor(userId, now = Date.now()) {
  const current = normalizedRecord(state[userId], now);
  state[userId] = current;
  return current;
}

function safeUserId(value) {
  const id = String(value || '');
  if (!/^\d{1,24}$/.test(id)) throw new Error('invalid user');
  return id;
}

function authorized(req) {
  const supplied = Buffer.from(String(req.headers['x-vm-secret'] || ''));
  const expected = Buffer.from(SECRET);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function docker(method, requestPath, body, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      socketPath: DOCKER_SOCKET,
      path: requestPath,
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total <= 256_000) chunks.push(chunk);
      });
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 400) return reject(new Error(`docker ${response.statusCode}: ${raw.slice(0, 300)}`));
        const type = String(response.headers['content-type'] || '');
        if (type.includes('json') && raw) {
          try { return resolve(JSON.parse(raw)); } catch {}
        }
        resolve(raw);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('docker timeout')));
    request.on('error', reject);
    if (payload) request.end(payload); else request.end();
  });
}

function publicState(userId, now = Date.now(), error = '') {
  const record = recordFor(userId, now);
  const quota = quotaView(record, now);
  return {
    ok: !error,
    version: '0.1 Beta',
    running: Boolean(record.containerId && record.activeStartedAt),
    machine: { os: 'Clop Linux Beta', ramMb: 1536, cpuPool: 2, network: false, runtimes: ['shell', 'nodejs-22', 'python3'] },
    quota,
    ...(error ? { error } : {}),
  };
}

async function inspectRunning(containerId) {
  if (!containerId) return false;
  try {
    const info = await docker('GET', `/containers/${encodeURIComponent(containerId)}/json`);
    return info?.State?.Running === true;
  } catch { return false; }
}

async function removeContainer(containerId) {
  if (!containerId) return;
  try { await docker('POST', `/containers/${encodeURIComponent(containerId)}/stop?t=2`); } catch {}
  try { await docker('DELETE', `/containers/${encodeURIComponent(containerId)}?force=true&v=true`); } catch {}
}

async function reconcile(userId, now = Date.now()) {
  const record = recordFor(userId, now);
  if (!record.containerId) return record;
  if (quotaView(record, now).remainingMs <= 0) {
    await removeContainer(record.containerId);
    state[userId] = settleRecord(record, now);
    state[userId].containerId = '';
    saveState();
    return state[userId];
  }
  if (!await inspectRunning(record.containerId)) {
    state[userId] = settleRecord(record, now);
    state[userId].containerId = '';
    saveState();
  }
  return state[userId];
}

async function startVm(userId) {
  const now = Date.now();
  let record = await reconcile(userId, now);
  if (record.containerId && record.activeStartedAt) return publicState(userId, now);
  if (quotaView(record, now).remainingMs <= 0) return publicState(userId, now, 'Недельный час уже использован. Новый час появится в понедельник.');

  const suffix = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
  const name = `clop-vm-${suffix}`;
  try { await docker('DELETE', `/containers/${encodeURIComponent(name)}?force=true&v=true`); } catch {}
  const created = await docker('POST', `/containers/create?name=${encodeURIComponent(name)}`, {
    Image: VM_IMAGE,
    User: '1000:1000',
    Cmd: ['sh', '-lc', 'trap : TERM INT; while :; do sleep 3600; done'],
    WorkingDir: '/home/clop',
    Labels: { 'clop.vm': 'beta', 'clop.vm.user': suffix },
    HostConfig: {
      AutoRemove: false,
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Memory: VM_MEMORY,
      MemorySwap: VM_MEMORY,
      NanoCpus: VM_CPU,
      PidsLimit: 128,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      CgroupParent: 'clop-vms.slice',
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,nodev,size=256m,mode=1777',
        '/home/clop': 'rw,nosuid,nodev,size=768m,mode=0700,uid=1000,gid=1000',
      },
    },
  });
  await docker('POST', `/containers/${encodeURIComponent(created.Id)}/start`);
  record.containerId = created.Id;
  record.activeStartedAt = now;
  state[userId] = record;
  saveState();
  return publicState(userId, now);
}

async function stopVm(userId) {
  const now = Date.now();
  const record = recordFor(userId, now);
  await removeContainer(record.containerId);
  state[userId] = settleRecord(record, now);
  state[userId].containerId = '';
  saveState();
  return publicState(userId, now);
}

async function runCommand(userId, commandText) {
  const command = String(commandText || '').trim();
  if (!command || command.length > 1000 || command.includes('\0')) throw new Error('Команда должна содержать от 1 до 1000 символов.');
  const now = Date.now();
  const record = await reconcile(userId, now);
  if (!record.containerId || !record.activeStartedAt) throw new Error('Сначала запустите виртуальную машину.');
  const created = await docker('POST', `/containers/${encodeURIComponent(record.containerId)}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    WorkingDir: '/home/clop',
    Cmd: ['timeout', '15', 'sh', '-lc', command],
  });
  const output = await docker('POST', `/exec/${encodeURIComponent(created.Id)}/start`, { Detach: false, Tty: true }, { timeoutMs: 18_000 });
  const inspected = await docker('GET', `/exec/${encodeURIComponent(created.Id)}/json`).catch(() => null);
  return {
    ...publicState(userId),
    output: String(output || '').slice(-64_000),
    exitCode: Number.isInteger(inspected?.ExitCode) ? inspected.ExitCode : null,
  };
}

async function withLock(userId, operation) {
  if (locks.has(userId)) throw new Error('Предыдущая операция ещё выполняется.');
  locks.add(userId);
  try { return await operation(); } finally { locks.delete(userId); }
}

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/health' && req.method === 'GET') return send(200, { ok: true });
  if (!authorized(req)) return send(401, { ok: false, error: 'unauthorized' });
  if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' });
  try {
    const body = await readBody(req);
    const userId = safeUserId(body.userId);
    const result = await withLock(userId, async () => {
      if (req.url === '/v1/status') { await reconcile(userId); return publicState(userId); }
      if (req.url === '/v1/start') return startVm(userId);
      if (req.url === '/v1/stop') return stopVm(userId);
      if (req.url === '/v1/command') return runCommand(userId, body.command);
      return null;
    });
    if (!result) return send(404, { ok: false, error: 'not found' });
    send(result.ok === false ? 429 : 200, result);
  } catch (error) {
    send(400, { ok: false, error: String(error.message || error).slice(0, 500) });
  }
});

setInterval(async () => {
  for (const userId of Object.keys(state)) {
    if (locks.has(userId) || !state[userId]?.activeStartedAt) continue;
    locks.add(userId);
    try { await reconcile(userId); } catch (error) { console.error('[vm] reconcile', userId, error.message); }
    finally { locks.delete(userId); }
  }
}, 5_000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`[vm] manager listening on ${PORT}; weekly limit ${WEEK_LIMIT_MS}ms`));
