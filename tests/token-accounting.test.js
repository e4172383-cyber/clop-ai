import test from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_VERSION, countCodexTokens, eventBillable } from '../src/token-accounting.js';

test('Codex cached input does not consume the user quota twice', () => {
  assert.deepEqual(countCodexTokens({
    input_tokens: 18_000,
    cached_input_tokens: 17_900,
    output_tokens: 25,
  }), {
    input: 18_000,
    output: 25,
    cacheWrite: 0,
    cacheRead: 17_900,
    total: 18_025,
    billable: 125,
  });
});

test('legacy GPT events are corrected while preserving their model multiplier', () => {
  const legacy = {
    input: 18_000,
    output: 25,
    cacheRead: 17_900,
    billable: Math.round(18_025 * 1.2),
  };
  assert.equal(eventBillable(legacy, 'gpt'), 150);
  assert.equal(eventBillable({ ...legacy, billingVersion: BILLING_VERSION }, 'gpt'), legacy.billable);
  assert.equal(eventBillable(legacy, 'kimi'), legacy.billable);
});

test('invalid or excessive cached counts cannot create negative usage', () => {
  const counted = countCodexTokens({ input_tokens: 20, cached_input_tokens: 500, output_tokens: 3 });
  assert.equal(counted.cacheRead, 20);
  assert.equal(counted.billable, 3);
});
