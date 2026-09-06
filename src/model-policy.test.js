import test from 'node:test';
import assert from 'node:assert/strict';
import { availablePlans, selectModel } from './model-policy.js';
import fs from 'node:fs/promises';
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

const { MODELS, DEFAULT_MODEL, PLANS } = await import('./config.js');

test('Astra is always restricted to GO and higher', () => {
  const plans = availablePlans(MODELS['gpt-astra'], Object.keys(PLANS), { models: ['gpt-astra'], from: 0, until: Infinity });
  assert.equal(plans.includes('free'), false);
  for (const paid of ['go','pro','max','max20','coderplus']) assert.ok(plans.includes(paid));
  assert.deepEqual(MODELS['gpt-astra'].plans, ['go','pro','max','max20','coderplus']);
  assert.deepEqual(MODELS['gpt-astra'].effortOptions, ['low','medium','high']);
});
test('all selectable bot models use GPT or Kimi, never Claude', () => {
  assert.ok(MODELS[DEFAULT_MODEL].plans.includes('free'));
  assert.equal(MODELS['gpt-astra'].cli,'gpt-6-astra');
  for (const m of Object.values(MODELS)) {
    assert.ok(['gpt','kimi'].includes(m.provider));
    assert.equal(m.fallbackModel,undefined);
  }
});
test('Clop aliases are removed and the new GPT models have the requested gates', () => {
  assert.equal(Object.keys(MODELS).some((key) => key.startsWith('clop-')), false);
  assert.ok(MODELS['gpt-5-4-mini'].plans.includes('free'));
  assert.ok(MODELS['gpt-terra'].plans.includes('free'));
  assert.deepEqual(MODELS['gpt-terra'].plans, ['free', 'go', 'pro', 'max', 'max20', 'coderplus']);
  assert.equal(MODELS['gpt-5-5'].plans.includes('free'), false);
  assert.ok(MODELS['gpt-5-5'].plans.includes('go'));
});
test('old Claude and free Astra selections safely use the default', () => {
  const promo = { models: ['gpt-astra'], from: 1000, until: 2000 };
  for (const old of ['sonnet-5','clop-2-5-haiku','fable-5']) {
    assert.equal(selectModel(MODELS,old,'free',DEFAULT_MODEL,Object.keys(PLANS),promo,1500).key, DEFAULT_MODEL);
  }
  assert.equal(selectModel(MODELS,'gpt-astra','free',DEFAULT_MODEL,Object.keys(PLANS),promo,1500).key,DEFAULT_MODEL);
  assert.equal(selectModel(MODELS,'gpt-astra','go',DEFAULT_MODEL,Object.keys(PLANS),promo,1500).key,'gpt-astra');
});
test('help and bot handlers do not dereference removed model keys', async () => {
  const source = await fs.readFile(new URL('./bot.js', import.meta.url),'utf8');
  for (const match of source.matchAll(/MODELS\[['"]([^'"]+)['"]\]/g)) assert.ok(MODELS[match[1]],match[1]);
});
