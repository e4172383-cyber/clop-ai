import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import test, { after, before, beforeEach } from 'node:test';

// Конфигурация читается при импорте модулей, поэтому тестовый порт и секреты
// задаются до динамического import. PORT=0 просит ОС выбрать свободный порт.
process.env.PORT = '0';
process.env.WEB_HOST = '127.0.0.1';
process.env.WEB_PASSWORD = 'web-test-password';
process.env.WEB_SESSION_SECRET = 'web-test-session-secret';
const TEST_PLAN_KEYS = ['free', 'go', 'pro', 'max', 'max20', 'coderplus'];
const TEST_PROVIDER_KEYS = ['claude', 'gpt', 'kimi'];
const SYNTHETIC_TOKEN_LIMIT = 100;
process.env.TOKEN_LIMITS_JSON = JSON.stringify(Object.fromEntries(TEST_PLAN_KEYS.map((plan) => [
  plan,
  Object.fromEntries(TEST_PROVIDER_KEYS.map((provider) => [
    provider,
    { short: SYNTHETIC_TOKEN_LIMIT, long: SYNTHETIC_TOKEN_LIMIT },
  ])),
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
  ]);
} finally {
  globalThis.setInterval = realSetInterval;
}
const [web, store, webchat, config, desktop] = modules;

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
      for (const window of ['short', 'long']) {
        assert.deepEqual(Object.keys(row[provider][window]).sort(), ['percent', 'resetAt']);
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

test('/chat/api/me and /chat fall back from a model unavailable on the current plan', async () => {
  const chat = store.newChat(user, 'Старая платная модель');
  chat.model = 'gpt-sol';

  const meResponse = await authed('/chat/api/me?chatId=' + encodeURIComponent(chat.id));
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json();
  assert.equal(me.models.find((model) => model.key === 'gpt-sol').available, false);
  assert.equal(me.currentModel, 'gpt-luna');
  assert.equal(me.chats.find((item) => item.id === chat.id).model, 'gpt-luna');

  const chatResponse = await authed('/chat/api/chat?id=' + encodeURIComponent(chat.id));
  assert.equal(chatResponse.status, 200);
  const body = await chatResponse.json();
  assert.equal(body.model, 'gpt-luna');
});

test('/chat/api/message names the Kimi provider when its limit is exhausted', async () => {
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
  assert.match(body.error, /^Лимит Kimi /);
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
