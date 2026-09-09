import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { once } from 'node:events';
import test, { after, before, beforeEach } from 'node:test';

// Конфигурация читается при импорте модулей, поэтому тестовый порт и секреты
// задаются до динамического import. PORT=0 просит ОС выбрать свободный порт.
process.env.PORT = '0';
process.env.WEB_HOST = '127.0.0.1';
process.env.WEB_PASSWORD = 'web-test-password';
process.env.WEB_SESSION_SECRET = 'web-test-session-secret';
process.env.CLOUD_INTERNAL_SECRET = 'web-test-internal-secret';
const TEST_PLAN_KEYS = ['free', 'go', 'pro', 'max', 'max20', 'coderplus'];
const TEST_PROVIDER_KEYS = ['claude', 'gpt', 'kimi', 'clop'];
const SYNTHETIC_TOKEN_LIMIT = 100;
process.env.TOKEN_LIMITS_JSON = JSON.stringify(Object.fromEntries(TEST_PLAN_KEYS.map((plan) => [
  plan,
  Object.fromEntries(TEST_PROVIDER_KEYS.map((provider) => [
    provider,
    { short: SYNTHETIC_TOKEN_LIMIT, long: SYNTHETIC_TOKEN_LIMIT },
  ])),
])));
process.env.CORPORATE_LIMITS_JSON = JSON.stringify(Object.fromEntries(['corp1', 'corp2', 'corp3', 'corp4'].map((plan) => [
  plan, { short: SYNTHETIC_TOKEN_LIMIT, long: SYNTHETIC_TOKEN_LIMIT * 10 },
])));


// bot.js, который импортирует web.js, держит служебный четырёхминутный timer.
// В тестовом процессе он не должен задерживать завершение test runner.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => realSetInterval(...args).unref();
let modules;
try {
  modules = await Promise.all([
    import('../src/web.js'),
    import('../src/store.js'),
    import('../src/webchat.js'),
    import('../src/config.js'),
    import('../src/desktop.js'),
    import('../src/limited-offer.js'),
  ]);
} finally {
  globalThis.setInterval = realSetInterval;
}
const [web, store, webchat, config, desktop, limitedOffer] = modules;

assert.equal(store.redisClient(), null, 'node:test must never connect to a configured production Redis');

let server;
let baseUrl;
let user;
let cookie;
let modelCalls = [];
let modelResults = [];

const okResult = (overrides = {}) => ({
  ok: true,
  provider: 'gpt',
  text: 'Готово.',
  threadId: 'thread-test',
  tokens: { input: 11, output: 7, total: 18, billable: 18, cacheWrite: 0, cacheRead: 0 },
  durationMs: 123,
  costUsd: 0,
  ...overrides,
});

async function fakeAsk(args) {
  modelCalls.push({
    client: args.client || 'chat',
    prompt: args.prompt,
    messages: args.chat.messages.map((message) => ({ role: message.role, content: message.content })),
    imageDir: args.images?.dir || null,
    imageDirExisted: Boolean(args.images?.dir && fs.existsSync(args.images.dir)),
  });
  return modelResults.shift() || okResult();
}

function resetUser() {
  store.raw().users = {};
  user = store.getUser({ id: 'web-route-test', first_name: 'Web', last_name: 'Test' });
  Object.assign(user, {
    plan: 'free',
    proUntil: 0,
    model: 'gpt-luna',
    effort: 'high',
    fast: true,
    activeChatId: null,
    chats: [],
    usage: [],
    images: [],
    stats: { requests: 0, tokens: 0, errors: 0 },
  });
  cookie = `${webchat.SESSION_COOKIE}=${encodeURIComponent(webchat.signSession(user.id))}`;
  modelCalls = [];
  modelResults = [];
}

function authed(pathname, options = {}) {
  return fetch(baseUrl + pathname, {
    ...options,
    headers: { cookie, ...(options.headers || {}) },
  });
}

before(async () => {
  server = web.startWeb({ askModelImpl: fakeAsk });
  if (!server.listening) await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(resetUser);

after(() => {
  if (!server?.listening) return;
  server.closeAllConnections();
  server.close();
});

test('serves only the fixed workspace stylesheet publicly with safe headers', async () => {
  const response = await fetch(baseUrl + '/workspace.css');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  assert.match(await response.text(), /^:root\s*\{/);

  const protectedResponse = await fetch(baseUrl + '/');
  assert.equal(protectedResponse.status, 401, 'the dashboard remains protected by Basic Auth');
  await protectedResponse.text();
});

test('/chat/api/plans publishes corporate prices and seats without exposing token pools', async () => {
  const response = await authed('/chat/api/plans');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.plans.filter((p) => p.key.startsWith('corp')).map((p) => [p.key, p.stars]), [
    ['corp1', 499], ['corp2', 999], ['corp3', 1799], ['corp4', 2999],
  ]);
  assert.equal(JSON.stringify(body).includes('short'), false);
  assert.equal(JSON.stringify(body).includes('long'), false);
  assert.equal(body.plans.some((p) => Object.hasOwn(p, 'limits')), false);
});

test('protected internal grants mutate the live store for offers and plans', async () => {
  user.username = 'grant_target';
  const unauthorized = await fetch(baseUrl + '/internal/admin/grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: '@grant_target', action: 'offer' }),
  });
  assert.equal(unauthorized.status, 401);

  const headers = {
    'content-type': 'application/json',
    'x-internal-secret': process.env.CLOUD_INTERNAL_SECRET,
  };
  const offerResponse = await fetch(baseUrl + '/internal/admin/grant', {
    method: 'POST', headers,
    body: JSON.stringify({ identifier: '@grant_target', action: 'offer' }),
  });
  assert.equal(offerResponse.status, 200);
  const offerBody = await offerResponse.json();
  assert.equal(offerBody.limitedOffer.active, true);
  assert.deepEqual(offerBody.limitedOffer.leftByModel, {
    'gpt-astra': 10_000_000,
    'kimi-k3': 1_000_000,
  });

  const planResponse = await fetch(baseUrl + '/internal/admin/grant', {
    method: 'POST', headers,
    body: JSON.stringify({ identifier: '@grant_target', action: 'plan', planKey: 'max20', days: 30 }),
  });
  assert.equal(planResponse.status, 200);
  const planBody = await planResponse.json();
  assert.equal(planBody.plan, 'max20');
  assert.equal(user.plan, 'max20');
  assert.ok(user.proUntil > Date.now() + 29 * config.DAY);

  const pendingResponse = await fetch(baseUrl + '/internal/admin/grant', {
    method: 'POST', headers,
    body: JSON.stringify({ identifier: '@future_user', action: 'offer', allowPending: true }),
  });
  assert.equal(pendingResponse.status, 202);
  assert.equal((await pendingResponse.json()).pending, true);
  const future = store.getUser({ id: 'future-user-id', username: 'future_user', first_name: 'Future' });
  assert.equal(limitedOffer.offerState(future).active, true);
  assert.equal(store.raw().pendingGrants.future_user, undefined);
});

test('recovery merge requires two secrets and keeps newer live user fields', async () => {
  user.username = 'live_user';
  user.plan = 'pro';
  user.chats = [{ id: 'live-chat', messages: [], updatedAt: Date.now() }];
  const snapshot = {
    users: {
      [user.id]: { ...user, plan: 'free', chats: [{ id: 'old-chat', messages: [], updatedAt: 1 }] },
      restored: {
        id: 'restored', username: 'restored_user', plan: 'free', chats: [], usage: [], payments: [],
        stats: { requests: 0, tokens: 0, errors: 0 },
      },
    },
  };
  const oneSecret = await fetch(baseUrl + '/internal/admin/merge-recovery', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': process.env.CLOUD_INTERNAL_SECRET },
    body: JSON.stringify({ snapshot }),
  });
  assert.equal(oneSecret.status, 401);

  const response = await fetch(baseUrl + '/internal/admin/merge-recovery', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': process.env.CLOUD_INTERNAL_SECRET,
      'x-recovery-secret': process.env.WEB_PASSWORD,
    },
    body: JSON.stringify({ snapshot }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).totalUsers, 2);
  assert.equal(store.findUser(user.id).plan, 'pro');
  assert.deepEqual(store.findUser(user.id).chats.map((chat) => chat.id).sort(), ['live-chat', 'old-chat']);
  assert.equal(store.findUser('restored').username, 'restored_user');
});

test('serves the public desktop release page and resumable installers without dashboard auth', async () => {
  const page = await fetch(baseUrl + '/download');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const html = await page.text();
  assert.match(html, /Android 8/);
  assert.match(html, /Clop-Code-Setup-2\.4\.1\.exe/);
  assert.match(html, /Clop-Code-2\.4\.1-linux-x64\.tar\.xz/);
  assert.match(html, /Clop-AI-Mobile-1\.0\.7\.apk/);
  assert.match(html, /href="\/downloads\/Clop-Code-Setup-2\.4\.1\.exe"/);
  assert.doesNotMatch(html, /release-assets\.githubusercontent\.com/);
  assert.doesNotMatch(html, /\d[\d ]{3,}\s*токен/iu);

  const releases = await fetch(baseUrl + '/releases.json');
  assert.equal(releases.status, 200);
  const releaseData = await releases.json();
  assert.equal(releaseData.desktop.version, '2.4.1');
  assert.match(releaseData.desktop.windowsUrl, /\/downloads\/Clop-Code-Setup-2\.4\.1\.exe$/);
  assert.match(releaseData.desktop.linuxUrl, /\/downloads\/Clop-Code-2\.4\.1-linux-x64\.tar\.xz$/);

  const partial = await fetch(baseUrl + '/downloads/Clop-Code-Setup-2.4.0.exe', {
    headers: { range: 'bytes=0-31' },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-length'), '32');
  assert.match(partial.headers.get('content-range'), /^bytes 0-31\/\d+$/);
  assert.match(partial.headers.get('content-disposition'), /Clop-Code-Setup-2\.4\.0\.exe/);
  assert.equal((await partial.arrayBuffer()).byteLength, 32);

  const apk = await fetch(baseUrl + '/downloads/Clop-AI-Mobile-1.0.7.apk', {
    headers: { range: 'bytes=0-3' },
  });
  assert.equal(apk.status, 206);
  assert.equal(Buffer.from(await apk.arrayBuffer()).toString('hex'), '504b0304');

  const missing = await fetch(baseUrl + '/downloads/private.env');
  assert.equal(missing.status, 404);
  await missing.text();
});

test('public status reports API and model routes without secrets or quota sizes', async () => {
  store.addUsage(user, {
    ts: Date.now() - 61_000,
    model: 'kimi-k2-6',
    output: 900,
    total: 1_000,
    durationMs: 1_000,
  });
  store.addUsage(user, {
    ts: Date.now(),
    model: 'gpt-luna',
    output: 120,
    total: 600,
    durationMs: 2_000,
  });
  const response = await fetch(baseUrl + '/status.json');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.server.processingMs, 'number');
  assert.equal(typeof body.server.uptimeSeconds, 'number');
  assert.equal(typeof body.traffic, 'object');
  assert.equal(body.traffic.requestWindowSeconds, 60);
  assert.equal(body.traffic.throughputWindowSeconds, 60);
  assert.equal(body.traffic.requestsPerSecond, 0.017);
  assert.equal(body.traffic.tokensPerSecond, 60);
  assert.equal(body.providers.gpt.tokensPerSecond, 60);
  assert.equal(body.providers.kimi.tokensPerSecond, 0, 'a message older than one minute leaves the speed window');
  assert.deepEqual(Object.keys(body.providers).sort(), ['clop', 'gpt', 'kimi']);
  assert.ok(body.models.some((model) => model.provider === 'gpt'));
  assert.ok(body.models.some((model) => model.provider === 'kimi'));
  assert.ok(body.models.some((model) => model.provider === 'clop'));
  assert.match(JSON.stringify(body), /GPT-6 Astra/);
  assert.doesNotMatch(JSON.stringify(body), /secret|auth|cli|quota/iu);
  assert.doesNotMatch(JSON.stringify(body), /inputTokens|outputTokens|totalTokens/iu);

  const secondResponse = await fetch(baseUrl + '/status.json?t=another-browser');
  const secondBody = await secondResponse.json();
  assert.equal(secondBody.generatedAt, body.generatedAt, 'all pages share one server measurement within the minute');
  assert.equal(secondBody.server.processingMs, body.server.processingMs);
  assert.equal(secondBody.traffic.tokensPerSecond, body.traffic.tokensPerSecond);
});

test('/chat/api/me exposes promo state and percentage-only provider limits', async () => {
  const response = await authed('/chat/api/me');
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(Object.hasOwn(body, 'modelPromo'), true);
  assert.equal(body.modelPromo, null);
  const catalogModel = body.models.find((model) => model.key === 'gpt-luna');
  assert.equal(catalogModel.description, config.MODELS['gpt-luna'].desc);
  assert.equal(typeof catalogModel.recommended, 'boolean');
  assert.equal(typeof catalogModel.heavy, 'boolean');
  assert.deepEqual(catalogModel.plans, config.MODELS['gpt-luna'].plans);
  for (const provider of Object.keys(config.PROVIDERS)) {
    for (const window of ['short', 'long']) {
      assert.equal(typeof body.limits[provider][window].percent, 'number');
      assert.equal(typeof body.limits[provider][window].exceeded, 'boolean');
      assert.equal(typeof body.limits[provider][window].resetAt, 'number');
      assert.deepEqual(Object.keys(body.limits[provider][window]).sort(), ['exceeded', 'percent', 'resetAt', 'title']);
    }
  }
  assert.doesNotMatch(JSON.stringify(body.limits), /"_(used|limit)"/);
});

test('/desk/me exposes only percentage token-limit state', async () => {
  const deviceId = 'desktop-limit-test';
  desktop.addDevice(user, deviceId, 'Test desktop');
  const token = desktop.signToken(user.id, deviceId);
  const response = await fetch(baseUrl + '/desk/me', {
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.doesNotMatch(JSON.stringify(body.limits), /"(?:_?used|_?limit)"/);
  for (const provider of Object.keys(config.PROVIDERS)) {
    for (const window of ['short', 'long']) {
      assert.deepEqual(
        Object.keys(body.limits[provider][window]).sort(),
        ['exceeded', 'percent', 'resetAt', 'title'],
      );
    }
  }
});

test('Remote web control requires the same account and desktop approval', async () => {
  const deviceId = 'desktop-remote-test';
  desktop.addDevice(user, deviceId, 'Remote test PC');
  const token = desktop.signToken(user.id, deviceId);
  const desktopHeaders = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

  const firstBeat = await fetch(baseUrl + '/desk/remote/heartbeat', {
    method: 'POST', headers: desktopHeaders,
    body: JSON.stringify({ name: 'Remote test PC', version: '2.4.0', enabled: true }),
  });
  assert.equal(firstBeat.status, 200);

  const devicesResponse = await authed('/chat/api/remote/devices');
  const devices = await devicesResponse.json();
  assert.equal(devices.version, '1.1 Beta');
  assert.equal(devices.devices[0].online, true);

  const requestResponse = await authed('/chat/api/remote/request', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }),
  });
  const requested = await requestResponse.json();
  assert.ok(requested.request.id);

  const requestBeat = await fetch(baseUrl + '/desk/remote/heartbeat', {
    method: 'POST', headers: desktopHeaders, body: JSON.stringify({ name: 'Remote test PC', version: '2.4.0', enabled: true }),
  }).then(response => response.json());
  assert.equal(requestBeat.request.id, requested.request.id);

  const decision = await fetch(baseUrl + '/desk/remote/decision', {
    method: 'POST', headers: desktopHeaders, body: JSON.stringify({ requestId: requested.request.id, allow: true }),
  }).then(response => response.json());
  assert.ok(decision.session.id);

  const queued = await authed('/chat/api/remote/command', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, sessionId: decision.session.id, type: 'screenshot', payload: {} }),
  }).then(response => response.json());
  assert.ok(queued.command.id);

  const commandBeat = await fetch(baseUrl + '/desk/remote/heartbeat', {
    method: 'POST', headers: desktopHeaders, body: JSON.stringify({ name: 'Remote test PC', version: '2.4.0', enabled: true }),
  }).then(response => response.json());
  assert.equal(commandBeat.commands[0].id, queued.command.id);

  const screen = `data:image/png;base64,${Buffer.from('remote-screen').toString('base64')}`;
  const finished = await fetch(baseUrl + '/desk/remote/result', {
    method: 'POST', headers: desktopHeaders,
    body: JSON.stringify({ id: queued.command.id, sessionId: decision.session.id, ok: true, screen }),
  });
  assert.equal(finished.status, 200);

  const status = await authed('/chat/api/remote/status?deviceId=' + deviceId).then(response => response.json());
  assert.equal(status.latestScreen.data, screen);
  assert.equal(status.results[0].ok, true);
});

test('Android Telegram login survives the confirmation round trip and returns a working token', async () => {
  const code = crypto.randomBytes(10).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const secretHash = crypto.createHash('sha256').update(secret).digest('base64url');
  const headers = { 'content-type': 'application/json' };

  const initialized = await fetch(baseUrl + '/desk/init', {
    method: 'POST', headers,
    body: JSON.stringify({ code, secretHash, device: 'Android login test' }),
  });
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).ok, true);
  assert.equal(store.raw().desktopPairs[code].secretHash, secretHash);

  assert.equal(desktop.claimPair(code, user.id), true);
  const redeemed = await fetch(baseUrl + '/desk/poll', {
    method: 'POST', headers,
    body: JSON.stringify({ code, secret }),
  });
  assert.equal(redeemed.status, 200);
  const login = await redeemed.json();
  assert.equal(login.ok, true);
  assert.match(login.token, /^[^.]+\.[^.]+$/);

  const profile = await fetch(baseUrl + '/desk/me', {
    headers: { authorization: 'Bearer ' + login.token },
  });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).ok, true);
});

test('/desk/chat marks the request as a desktop action client', async () => {
  const deviceId = 'desktop-action-client';
  desktop.addDevice(user, deviceId, 'Clop Code test');
  const token = desktop.signToken(user.id, deviceId);
  modelResults.push(okResult({ text: '<clop_action>{"tool":"write","path":"index.html","content":"ok"}</clop_action>' }));

  const response = await fetch(baseUrl + '/desk/chat', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Создай сайт', model: 'gpt-luna' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(modelCalls[0].client, 'desktop');
});

test('a user can submit a bug and the admin can accept it with one idempotent reward', async () => {
  const createdResponse = await authed('/chat/api/bugs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'Кнопка отправки не реагирует после второго нажатия', platform: 'Сайт' }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.bug.status, 'open');

  const authorization = `Basic ${Buffer.from(':web-test-password').toString('base64')}`;
  const catalogResponse = await fetch(baseUrl + '/api/tickets', { headers: { authorization } });
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.deepEqual(catalog.bugRewards.map((reward) => reward.key), [
    'reset5h', 'bonus50', 'bonus75', 'bonus100', 'bonus250', 'bonus500', 'bonus1000',
  ]);

  const invalidDecision = await fetch(baseUrl + '/api/ticket/decision', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ id: created.bug.id, decision: 'accepted', reward: 'unknown' }),
  });
  assert.equal(invalidDecision.status, 400);

  const decide = () => fetch(baseUrl + '/api/ticket/decision', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ id: created.bug.id, decision: 'accepted', reward: 'bonus50' }),
  });
  const decisionResponse = await decide();
  assert.equal(decisionResponse.status, 200);
  const decision = await decisionResponse.json();
  assert.equal(decision.bonuses.balance, 50);
  assert.equal(decision.ticket.reward.amount, 50);

  assert.equal((await decide()).status, 400);
  const own = await (await authed('/chat/api/bugs')).json();
  assert.equal(own.bonuses.balance, 50);
  assert.equal(own.bugs.find((bug) => bug.id === created.bug.id).status, 'accepted');
});

test('/desk/chat does not charge a desktop task when the model performs no action', async () => {
  const deviceId = 'desktop-no-action';
  desktop.addDevice(user, deviceId, 'Clop Code no-action test');
  const token = desktop.signToken(user.id, deviceId);
  modelResults.push(okResult({
    text: 'Уточните, какой файл нужно изменить.',
    tokens: { input: 650_000, output: 453, total: 650_453, billable: 900, promptTokens: 447, cacheWrite: 0, cacheRead: 649_553 },
  }));
  const prompt = '<clop_protocol>ROLE: You are the execution engine inside Clop Code. ACCESS: mode=workspace; active working directory=C:/project.</clop_protocol>\n<user_request>Сделай оптимизацию проекта</user_request>';

  const response = await fetch(baseUrl + '/desk/chat', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ text: prompt, model: 'gpt-luna' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.quotaCharged, false);
  assert.equal(body.tokens.total, 0);
  assert.equal(user.usage.length, 0);
  assert.equal(user.chats[0].messages.some((message) => message.content === 'Уточните, какой файл нужно изменить.'), false);
});

test('admin can refund a bounded window of failed desktop usage', async () => {
  const now = Date.now();
  user.usage.push(
    { ts: now - 2_000, source: 'desktop', total: 650_453, billable: 2_000 },
    { ts: now - 1_000, source: 'site-chat', total: 50, billable: 50 },
  );
  user.stats.requests = 2;
  user.stats.tokens = 650_503;
  const authorization = 'Basic ' + Buffer.from('admin:web-test-password').toString('base64');
  const response = await fetch(baseUrl + '/api/user/refund-usage', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id, from: now - 3_000, to: now }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { ok: true, removed: 1, refunded: 2_000 });
  assert.equal(user.usage.length, 1);
  assert.equal(user.usage[0].source, 'site-chat');
  assert.equal(user.stats.requests, 1);
  assert.equal(user.stats.tokens, 50);
});

test('the limited offer unlocks Astra and keeps its covered usage outside plan limits', async () => {
  user.limitedOffer = {
    id: config.LIMITED_OFFER.id,
    claimedAt: Date.now(),
    until: Date.now() + 60_000,
    usedByModel: { 'gpt-astra': 0, 'kimi-k3': 0 },
  };
  user.model = 'gpt-astra';

  const profile = await authed('/chat/api/me');
  assert.equal(profile.status, 200);
  const body = await profile.json();
  assert.equal(body.models.find((model) => model.key === 'gpt-astra').available, true);
  assert.equal(body.models.find((model) => model.key === 'kimi-k3').available, true);
  assert.equal(body.models.find((model) => model.key === 'gpt-sol').available, true);
  assert.deepEqual(body.models.find((model) => model.key === 'gpt-sol').ratings, { price: 2, speed: 3, quality: 5 });
  assert.equal(body.models.find((model) => model.key === 'gpt-sol').limitMultiplier, undefined);
  assert.equal(body.limitedOffer.active, true);

  modelResults.push(okResult({ tokens: { input: 11, output: 7, total: 18, billable: 18, cacheWrite: 0, cacheRead: 0 } }));
  const answer = await authed('/chat/api/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Проверка бонуса', model: 'gpt-astra' }),
  });
  assert.equal(answer.status, 200);
  assert.equal(user.limitedOffer.usedByModel['gpt-astra'], 18);
  assert.equal(user.limitedOffer.usedByModel['kimi-k3'], 0);
  assert.equal(user.usage.at(-1).offerBonus, true);
  assert.equal((await answer.json()).limits.gpt.short.percent, 0);
});

test('offer claim and expiry are calculated from server time', () => {
  assert.deepEqual(config.LIMITED_OFFER.budgets, { 'gpt-astra': 10_000_000, 'kimi-k3': 1_000_000 });
  assert.equal(config.LIMITED_OFFER.claimDurationMs, 60 * 60 * 1000);
  assert.equal(config.LIMITED_OFFER.durationMs, 5 * 60 * 60 * 1000);
  assert.deepEqual(config.LIMITED_OFFER.models, ['gpt-astra', 'kimi-k3']);
  const sample = {};
  const claimUntil = limitedOffer.offerState({}, Date.now()).claimUntil;
  const beforeClose = claimUntil - 1000;
  const claimed = limitedOffer.claimOffer(sample, beforeClose);
  assert.equal(claimed.active, true);
  assert.equal(claimed.until, beforeClose + config.LIMITED_OFFER.durationMs);
  assert.equal(limitedOffer.offerState({}, claimUntil), null);
});

test('Astra and Kimi K3 promotion balances are independent and capped', () => {
  const now = Date.now();
  const sample = {};
  limitedOffer.claimOffer(sample, now);
  assert.equal(limitedOffer.addOfferUsage(sample, 'gpt-astra', 25, now), 25);
  assert.equal(limitedOffer.addOfferUsage(sample, 'kimi-k3', 40, now), 40);
  sample.limitedOffer.usedByModel['kimi-k3'] = 999_990;
  assert.equal(limitedOffer.addOfferUsage(sample, 'kimi-k3', 100, now), 10);
  const state = limitedOffer.offerState(sample, now);
  assert.equal(state.usedByModel['gpt-astra'], 25);
  assert.equal(state.leftByModel['kimi-k3'], 0);
  assert.equal(state.leftByModel['gpt-astra'], 9_999_975);
});

test('/desk/voice tracks the weekly session on the authenticated account', async () => {
  const deviceId = 'voice-device-test';
  desktop.addDevice(user, deviceId, 'Test Android');
  const token = desktop.signToken(user.id, deviceId);
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

  const started = await fetch(baseUrl + '/desk/voice/start', { method: 'POST', headers, body: '{}' });
  assert.equal(started.status, 200);
  const startBody = await started.json();
  assert.equal(startBody.voice.limitSeconds, 9000);
  assert.match(startBody.sessionId, /^[0-9a-f-]{36}$/);

  const heartbeat = await fetch(baseUrl + '/desk/voice/heartbeat', {
    method: 'POST', headers, body: JSON.stringify({ sessionId: startBody.sessionId }),
  });
  assert.equal(heartbeat.status, 200);
  assert.equal((await heartbeat.json()).ok, true);

  const stopped = await fetch(baseUrl + '/desk/voice/stop', {
    method: 'POST', headers, body: JSON.stringify({ sessionId: startBody.sessionId }),
  });
  assert.equal(stopped.status, 200);
  assert.equal(user.voiceSessionId, undefined);
});

test('/api/stats never returns quota sizes, even to the admin dashboard', async () => {
  const credentials = Buffer.from('admin:web-test-password').toString('base64');
  const response = await fetch(baseUrl + '/api/stats', {
    headers: { authorization: 'Basic ' + credentials },
  });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(Object.hasOwn(body, 'plans'), false);
  assert.doesNotMatch(JSON.stringify(body.users), /"(?:_?used|_?limit)"/);
  for (const row of body.users) {
    for (const provider of Object.keys(config.PROVIDERS)) {
      for (const window of Object.values(row[provider])) {
        assert.deepEqual(Object.keys(window).sort(), ['percent', 'resetAt']);
      }
    }
  }
});

test('/chat/api/chat returns the selected chat model with effective effort and fast mode', async () => {
  const chat = store.newChat(user, 'Проверка настроек');
  chat.model = 'gpt-5-4-mini';

  const response = await authed('/chat/api/chat?id=' + encodeURIComponent(chat.id));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.model, 'gpt-5-4-mini');
  assert.equal(body.effort, 'high');
  assert.equal(body.fast, true);
});

test('/chat/api/me and /chat keep GPT 5.6 Sol available on the free plan', async () => {
  const chat = store.newChat(user, 'Старая платная модель');
  chat.model = 'gpt-sol';

  const meResponse = await authed('/chat/api/me?chatId=' + encodeURIComponent(chat.id));
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json();
  const sol = me.models.find((model) => model.key === 'gpt-sol');
  assert.equal(sol.available, true);
  assert.deepEqual(sol.ratings, { price: 2, speed: 3, quality: 5 });
  assert.equal(me.currentModel, 'gpt-sol');
  assert.equal(me.chats.find((item) => item.id === chat.id).model, 'gpt-sol');

  const chatResponse = await authed('/chat/api/chat?id=' + encodeURIComponent(chat.id));
  assert.equal(chatResponse.status, 200);
  const body = await chatResponse.json();
  assert.equal(body.model, 'gpt-sol');
});

test('/chat/api/message names the shared pool when its limit is exhausted', async () => {
  user.model = 'kimi-k2-6';
  user.usage.push({
    ts: Date.now(),
    model: 'kimi-k2-6',
    billable: config.PLANS.free.limits.kimi.short,
    total: config.PLANS.free.limits.kimi.short,
  });

  const response = await authed('/chat/api/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Привет', model: 'kimi-k2-6' }),
  });
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.match(body.error, /^Общий лимит /);
  assert.equal(modelCalls.length, 0);
});

test('/chat/api/message keeps the current prompt out of history, cleans vision temp and returns usage', async () => {
  const chat = store.newChat(user, 'Проверка сообщения');
  store.pushMessage(chat, 'user', 'Старый вопрос');
  store.pushMessage(chat, 'assistant', 'Старый ответ');
  modelResults.push(okResult({
    text: ['Готово.', '%%%FILE app.js%%%', 'console.log("ok");', '%%%ENDFILE%%%'].join('\n'),
  }));
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  const response = await authed('/chat/api/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Новый вопрос', model: 'gpt-luna', chatId: chat.id, images: [png] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.text, 'Готово.');
  assert.deepEqual(body.usage, { input: 11, output: 7, total: 18 });
  assert.equal(body.durationMs, 123);
  assert.equal(typeof body.zip, 'string');
  assert.equal(body.artifacts.length, 1);
  assert.equal(body.artifacts[0].name, 'app.js');
  assert.equal(body.artifacts[0].size, 19);
  assert.equal(body.artifacts[0].mimeType, 'text/javascript; charset=utf-8');
  assert.match(body.artifacts[0].downloadUrl, /^\/chat\/api\/artifact\?id=[A-Za-z0-9_-]+\.0$/);
  assert.ok(body.artifacts[0].expiresAt > Date.now());
  assert.equal(typeof body.limits.gpt.short.percent, 'number');
  assert.doesNotMatch(JSON.stringify(body.limits), /"_(used|limit)"/);

  assert.deepEqual(modelCalls[0].messages, [
    { role: 'user', content: 'Старый вопрос' },
    { role: 'assistant', content: 'Старый ответ' },
  ]);
  assert.equal(modelCalls[0].prompt, 'Новый вопрос');
  assert.equal(modelCalls[0].imageDirExisted, true);
  assert.equal(fs.existsSync(modelCalls[0].imageDir), false, 'vision temp directory is removed in finally');

  assert.equal(chat.messages.at(-2).content, 'Новый вопрос');
  assert.equal(chat.messages.at(-1).displayText, 'Готово.');
  assert.doesNotMatch(chat.messages.at(-1).content, /%%%FILE/);
  assert.match(chat.messages.at(-1).content, /Созданный файл «app\.js»:[\s\S]*console\.log\("ok"\);/);
  assert.deepEqual(chat.messages.at(-1).artifacts, body.artifacts);
  assert.doesNotMatch(JSON.stringify(chat.messages.at(-1).artifacts), /console\.log|base64|"data"|"content"/);

  const historyResponse = await authed('/chat/api/chat?id=' + encodeURIComponent(chat.id));
  const history = await historyResponse.json();
  assert.equal(history.messages.at(-1).content, 'Готово.');
  assert.deepEqual(history.messages.at(-1).artifacts, body.artifacts);

  const unauthenticatedDownload = await fetch(baseUrl + body.artifacts[0].downloadUrl);
  assert.equal(unauthenticatedDownload.status, 401);
  await unauthenticatedDownload.text();

  const other = store.getUser({ id: 'other-web-user', first_name: 'Other' });
  const otherCookie = `${webchat.SESSION_COOKIE}=${encodeURIComponent(webchat.signSession(other.id))}`;
  const forbiddenDownload = await fetch(baseUrl + body.artifacts[0].downloadUrl, { headers: { cookie: otherCookie } });
  assert.equal(forbiddenDownload.status, 404);
  await forbiddenDownload.text();

  const download = await authed(body.artifacts[0].downloadUrl);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''app\.js/);
  assert.equal(await download.text(), 'console.log("ok");\n');

  const followupResponse = await authed('/chat/api/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Продолжай', model: 'gpt-luna', chatId: chat.id }),
  });
  await followupResponse.json();
  const restoredAssistant = modelCalls[1].messages.findLast((message) => message.role === 'assistant');
  assert.match(restoredAssistant.content, /Созданный файл «app\.js»:[\s\S]*console\.log\("ok"\);/);
  assert.equal(modelCalls[1].messages.some((message) => message.content === 'Продолжай'), false);
});

test('/chat/api/message returns the percentage limits after recording usage', async () => {
  user.fast = false;
  const limit = config.PLANS.free.limits.gpt.short;
  const billable = Math.ceil(limit / 2);
  modelResults.push(okResult({
    tokens: { input: billable, output: 0, total: billable, billable, cacheWrite: 0, cacheRead: 0 },
  }));

  const response = await authed('/chat/api/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Потрать половину окна', model: 'gpt-luna' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.limits.gpt.short.percent, Math.round((billable / limit) * 100));
  assert.equal(body.limits.gpt.short.exceeded, false);
  assert.deepEqual(Object.keys(body.limits.gpt.short).sort(), ['exceeded', 'percent', 'resetAt', 'title']);

  const profile = await authed('/chat/api/profile').then((result) => result.json());
  assert.deepEqual(body.limits.gpt, profile.limits.gpt);
});

test('/chat/api/message never spends quota when the model returns an error', async () => {
  const chat = store.newChat(user, 'Ошибка без списания');
  const beforeUsage = user.usage.length;
  const beforeMessages = chat.messages.length;
  modelResults.push({ ok: false, provider: 'gpt', error: 'temporary provider failure' });

  const response = await authed('/chat/api/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Этот запрос не должен списаться', model: 'gpt-luna', chatId: chat.id }),
  });

  assert.equal(response.status, 502);
  assert.equal(user.usage.length, beforeUsage);
  assert.equal(chat.messages.length, beforeMessages);
  assert.equal(user.stats.tokens, 0);
});

test('/chat/api/message preserves partial content from an unfinished final file', async () => {
  const chat = store.newChat(user, 'Оборванный проект');
  modelResults.push(okResult({
    text: [
      'Начал проект.',
      '%%%FILE ready.txt%%%',
      'готово',
      '%%%ENDFILE%%%',
      '%%%FILE unfinished.js%%%',
      'const unfinished = true;',
    ].join('\n'),
  }));

  const response = await authed('/chat/api/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Сделай два файла', model: 'gpt-luna', chatId: chat.id }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.text, /unfinished\.js.*не был завершён/);
  const saved = chat.messages.at(-1).content;
  assert.doesNotMatch(saved, /%%%FILE|%%%ENDFILE/);
  assert.match(saved, /Незавершённый файл «unfinished\.js»[\s\S]*const unfinished = true;/);

  const history = await authed('/chat/api/chat?id=' + encodeURIComponent(chat.id)).then((result) => result.json());
  assert.equal(history.messages.at(-1).content, body.text);

  const followup = await authed('/chat/api/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Продолжай незавершённый файл', model: 'gpt-luna', chatId: chat.id }),
  });
  assert.equal(followup.status, 200);
  await followup.json();
  const restoredAssistant = modelCalls[1].messages.findLast((message) => message.role === 'assistant');
  assert.match(restoredAssistant.content, /unfinished\.js[\s\S]*const unfinished = true;/);
});
