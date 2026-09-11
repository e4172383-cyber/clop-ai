import test from 'node:test';
import assert from 'node:assert/strict';
import { availablePlans, selectModel } from './model-policy.js';
import fs from 'node:fs/promises';
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

const { MODELS, DEFAULT_MODEL, PLANS } = await import('./config.js');

test('Astra is selectable on free and every paid plan', () => {
  const plans = availablePlans(MODELS['gpt-astra'], Object.keys(PLANS), { models: ['gpt-astra'], from: 0, until: Infinity });
  assert.equal(plans.includes('free'), true);
  for (const paid of ['go','pro','max','max20','coderplus']) assert.ok(plans.includes(paid));
  assert.deepEqual(MODELS['gpt-astra'].plans, ['free','go','pro','max','max20','coderplus']);
  assert.deepEqual(MODELS['gpt-astra'].effortOptions, ['low','medium','high']);
  assert.deepEqual(MODELS['gpt-astra'].effortOptionsByPlan.free, ['low']);
});
test('all selectable bot models use GPT, Kimi or the separate Clop pool, never Claude', () => {
  assert.ok(MODELS[DEFAULT_MODEL].plans.includes('free'));
  assert.equal(MODELS['gpt-astra'].cli,'gpt-6-astra');
  for (const m of Object.values(MODELS)) {
    assert.ok(['gpt','kimi','clop'].includes(m.provider));
    assert.equal(m.fallbackModel,undefined);
  }
});
test('Kimi K2.8 uses the live Kimi Code alias and is available on free', () => {
  assert.equal(MODELS['kimi-k2-8'].cli, 'kimi-code/kimi-for-coding');
  assert.equal(MODELS['kimi-k2-8'].kimiEffort, 'on');
  assert.ok(MODELS['kimi-k2-8'].plans.includes('free'));
  assert.equal(MODELS['kimi-k2-7-code'].cli, 'kimi-code/kimi-for-coding-highspeed');
});
test('Clop 4 models have fixed Medium behavior and Pulsar starts at GO', () => {
  assert.deepEqual(Object.keys(MODELS).filter((key) => key.startsWith('clop-')), [
    'clop-4-pulsar', 'clop-4-pro', 'clop-4-flash',
  ]);
  assert.deepEqual(MODELS['clop-4-pulsar'].plans, ['go', 'pro', 'max', 'max20', 'coderplus']);
  assert.equal(MODELS['clop-4-pulsar'].fixedEffort, 'medium');
  assert.equal(MODELS['clop-4-pro'].fixedEffort, 'medium');
  assert.equal(MODELS['clop-4-flash'].fixedEffort, 'medium');
  assert.equal(MODELS['clop-4-flash'].limitMultiplier, 1.5);
  for (const key of ['clop-4-pulsar', 'clop-4-pro', 'clop-4-flash']) {
    assert.equal(MODELS[key].provider, 'clop');
    assert.equal(MODELS[key].runtime, 'gpt');
    assert.equal(MODELS[key].supportsEffort, false);
    assert.equal(MODELS[key].hideIdentity, true);
  }
  assert.ok(MODELS['gpt-luna'].plans.includes('free'));
  assert.ok(MODELS['gpt-terra'].plans.includes('free'));
  assert.deepEqual(MODELS['gpt-terra'].plans, ['free', 'go', 'pro', 'max', 'max20', 'coderplus']);
  assert.equal(MODELS['gpt-5-5'].plans.includes('free'), false);
  assert.ok(MODELS['gpt-5-5'].plans.includes('go'));
});
test('old Claude selections use the default while free Astra remains selectable', () => {
  const promo = { models: ['gpt-astra'], from: 1000, until: 2000 };
  for (const old of ['gpt-5-4-mini','sonnet-5','clop-2-5-haiku','clop-3-1-opus','fable-5']) {
    assert.equal(selectModel(MODELS,old,'free',DEFAULT_MODEL,Object.keys(PLANS),promo,1500).key, DEFAULT_MODEL);
  }
  assert.equal(selectModel(MODELS,'gpt-astra','free',DEFAULT_MODEL,Object.keys(PLANS),promo,1500).key,'gpt-astra');
  assert.equal(selectModel(MODELS,'gpt-astra','go',DEFAULT_MODEL,Object.keys(PLANS),promo,1500).key,'gpt-astra');
});
test('help and bot handlers do not dereference removed model keys', async () => {
  const source = await fs.readFile(new URL('./bot.js', import.meta.url),'utf8');
  for (const match of source.matchAll(/MODELS\[['"]([^'"]+)['"]\]/g)) assert.ok(MODELS[match[1]],match[1]);
});
