import assert from 'node:assert/strict';
import test from 'node:test';

const plans = ['free', 'go', 'pro', 'max', 'max20', 'coderplus'];
const providers = ['claude', 'gpt', 'kimi', 'clop'];
process.env.TOKEN_LIMITS_JSON = JSON.stringify(Object.fromEntries(plans.map((plan) => [
  plan,
  Object.fromEntries(providers.map((provider) => [provider, { short: 1_000, long: 10_000 }])),
])));

const { ask } = await import('../src/kimi.js');

test('a fresh Kimi web or Telegram chat answers a greeting without invented protocol text', async () => {
  const result = await ask({
    chat: { id: 'greeting', messages: [] },
    modelCli: 'kimi-code/kimi-for-coding',
    kimiEffort: 'on',
    prompt: 'привет',
    client: 'chat',
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Привет! Чем помочь?');
  assert.equal(result.tokens.billable, 0);
  assert.doesNotMatch(result.text, /protocol|протокол|компьютер|экран/iu);
});
