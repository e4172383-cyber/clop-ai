import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTokenLimits } from '../src/token-limits.js';

const SCHEMA = {
  plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'],
  providers: ['claude', 'gpt', 'kimi', 'clop'],
  windows: ['short', 'long'],
};
const SYNTHETIC_TOKEN_LIMIT = 100;

function syntheticMatrix() {
  return Object.fromEntries(SCHEMA.plans.map((plan) => [
    plan,
    Object.fromEntries(SCHEMA.providers.map((provider) => [
      provider,
      { short: SYNTHETIC_TOKEN_LIMIT, long: SYNTHETIC_TOKEN_LIMIT },
    ])),
  ]));
}

test('accepts a complete synthetic token-limit matrix and freezes its copy', () => {
  const input = syntheticMatrix();
  const parsed = parseTokenLimits(JSON.stringify(input), SCHEMA);

  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.free), true);
  assert.equal(Object.isFrozen(parsed.free.gpt), true);
});

test('accepts null to disable a plan window for one provider', () => {
  const input = syntheticMatrix();
  input.max.clop.short = null;
  const parsed = parseTokenLimits(JSON.stringify(input), SCHEMA);
  assert.equal(parsed.max.clop.short, null);
  assert.equal(parsed.max.clop.long, SYNTHETIC_TOKEN_LIMIT);
});

test('fails closed when TOKEN_LIMITS_JSON is absent or malformed', () => {
  for (const raw of [undefined, '', 'not-json', '[]']) {
    assert.throws(() => parseTokenLimits(raw, SCHEMA), /TOKEN_LIMITS_JSON/);
  }
});

test('requires every configured plan, provider and window with no extra keys', () => {
  const variants = [];

  const missingPlan = syntheticMatrix();
  delete missingPlan.free;
  variants.push(missingPlan);

  const extraPlan = syntheticMatrix();
  extraPlan.extra = extraPlan.free;
  variants.push(extraPlan);

  const missingProvider = syntheticMatrix();
  delete missingProvider.free.gpt;
  variants.push(missingProvider);

  const missingWindow = syntheticMatrix();
  delete missingWindow.free.gpt.long;
  variants.push(missingWindow);

  const extraWindow = syntheticMatrix();
  extraWindow.free.gpt.monthly = SYNTHETIC_TOKEN_LIMIT;
  variants.push(extraWindow);

  for (const value of variants) {
    assert.throws(() => parseTokenLimits(JSON.stringify(value), SCHEMA), /must contain exactly the configured keys/);
  }
});

test('rejects unsafe quota values and an inverted short/long window', () => {
  for (const invalidValue of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const matrix = syntheticMatrix();
    matrix.free.gpt.short = invalidValue;
    assert.throws(() => parseTokenLimits(JSON.stringify(matrix), SCHEMA), /positive safe integer/);
  }

  const inverted = syntheticMatrix();
  inverted.free.gpt.short = SYNTHETIC_TOKEN_LIMIT + 1;
  assert.throws(() => parseTokenLimits(JSON.stringify(inverted), SCHEMA), /long must be greater than or equal to short/);
});
