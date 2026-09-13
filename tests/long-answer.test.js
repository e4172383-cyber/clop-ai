import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TOKEN_LIMITS_JSON ||= JSON.stringify(Object.fromEntries(
  ['free', 'go', 'pro', 'max', 'max20', 'coderplus'].map((plan) => [plan,
    Object.fromEntries(['claude', 'gpt', 'kimi', 'clop'].map((provider) => [provider, { short: 100, long: 1000 }]))]),
));

const { ask, transientConnectionFailure } = await import('../src/gpt.js');
const { resumeSessionLost } = await import('../src/codexrun.js');
const { wantsProjectOutput, hasProjectOutput, projectPrompt, combineModelUsage } = await import('../src/project-output.js');
const { deliverFinalMessage } = await import('../src/telegram-delivery.js');
const { chunkText } = await import('../src/telegram.js');

test('a partial GPT preamble followed by timeout is not a completed answer', async () => {
  const result = await ask({
    chat: { id: 'long-task', messages: [], gptThreadId: null },
    modelCli: 'gpt-5.6-terra', prompt: 'Сделай большой проект',
    runImpl: async () => ({ ok: false, text: 'Сейчас я подумаю и начну писать код.', error: 'timeout', code: null }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /10 минут/);
  assert.equal(result.tokens, undefined);
});

test('network failures are not mistaken for a lost Codex session', () => {
  assert.equal(resumeSessionLost({ error: 'timeout' }), false);
  assert.equal(resumeSessionLost({ errMsg: 'network unavailable' }), false);
  assert.equal(resumeSessionLost({ errMsg: 'thread not found' }), true);
  assert.equal(transientConnectionFailure({ errMsg: 'fetch failed: EAI_AGAIN' }), true);
  assert.equal(transientConnectionFailure({ errMsg: '401 unauthorized' }), false);
});

test('a transient connection error gets one bounded retry and only a completed reply succeeds', async () => {
  let calls = 0;
  const result = await ask({
    chat: { id: 'retry', messages: [], gptThreadId: null }, modelCli: 'gpt-5.6-terra', prompt: 'Привет',
    runImpl: async () => (++calls === 1
      ? { ok: false, error: 'fetch failed: EAI_AGAIN' }
      : { ok: true, text: 'Привет!', threadId: 'thread-1', usage: { input_tokens: 1, output_tokens: 2 } }),
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Привет!');
});

test('project request requires actual files or code and sums a continuation usage', () => {
  assert.equal(wantsProjectOutput('сделай большое приложение с ботом'), true);
  assert.equal(wantsProjectOutput('создай сайт с авторизацией'), true);
  assert.equal(wantsProjectOutput('что такое приложение?'), false);
  assert.match(projectPrompt('создай сайт'), /выдай сам рабочий код/);
  assert.equal(hasProjectOutput('Сначала я обдумаю структуру.'), false);
  assert.equal(hasProjectOutput('```js\nconsole.log(1)\n```'), true);
  assert.equal(hasProjectOutput('%%%FILE index.html%%%\n<html></html>\n%%%ENDFILE%%%'), true);
  const result = combineModelUsage(
    { tokens: { input: 10, output: 20, billable: 30, total: 30 }, durationMs: 1000 },
    { ok: true, text: '```js\ncode\n```', tokens: { input: 15, output: 25, billable: 40, total: 40 }, durationMs: 2000 },
  );
  assert.equal(result.tokens.billable, 70);
  assert.equal(result.durationMs, 3000);
});

test('long Telegram final replaces preview and sends every remaining chunk', async () => {
  const sent = [];
  const telegram = {
    chunkText,
    editMessage: async (_chat, _id, text) => { sent.push(['edit', text]); return { message_id: 1 }; },
    sendMessage: async (_chat, text) => { sent.push(['send', text]); return { message_id: 2 }; },
  };
  const answer = 'Код проекта:\n\n' + Array.from({ length: 300 }, (_, i) => `строка ${i}: const x = ${i};`).join('\n');
  await deliverFinalMessage(telegram, 42, 1, answer);
  assert.ok(sent.length > 1);
  assert.equal(sent[0][0], 'edit');
  assert.equal(sent.slice(1).every(([kind]) => kind === 'send'), true);
  assert.ok(sent.every(([, text]) => text.length <= 3900));
  assert.equal(sent.map(([, text]) => text).join('\n').replace(/\n+/g, '\n'), answer.replace(/\n+/g, '\n'));
});

test('failed Telegram edit falls back to sending the entire final answer', async () => {
  const sent = [];
  await deliverFinalMessage({
    chunkText,
    editMessage: async () => null,
    sendMessage: async (_chat, text) => { sent.push(text); },
  }, 42, 1, 'Готовый код');
  assert.deepEqual(sent, ['Готовый код']);
});
