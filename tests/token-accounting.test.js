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
    promptTokens: 100,
    billable: 125,
  });
});

test('resumed GPT context is not charged again for every message', () => {
  const counted = countCodexTokens({
    input_tokens: 54_865,
    cached_input_tokens: 12_160,
    output_tokens: 48,
  }, { prompt: 'привет' });

  assert.equal(counted.input, 54_865);
  assert.equal(counted.promptTokens, 3);
  assert.equal(counted.billable, 51);
});

test('images receive a bounded fresh-input allowance without recharging history', () => {
  const counted = countCodexTokens({
    input_tokens: 20_000,
    cached_input_tokens: 10_000,
    output_tokens: 100,
  }, { prompt: 'describe', imageCount: 2 });

  assert.equal(counted.promptTokens, 2_002);
  assert.equal(counted.billable, 2_102);
});

test('legacy GPT events are corrected while preserving their model multiplier', () => {
  const legacy = {
    input: 18_000,
    output: 25,
    cacheRead: 17_900,
    billable: Math.round(18_025 * 1.2),
  };
  assert.equal(eventBillable(legacy, 'gpt'), 75);
  assert.equal(eventBillable({ ...legacy, billingVersion: BILLING_VERSION }, 'gpt'), Math.round(legacy.billable / 2));
  assert.equal(eventBillable(legacy, 'kimi'), legacy.billable);
});

test('version 2 GPT events are reduced when resumed context was charged repeatedly', () => {
  const event = {
    input: 54_865,
    output: 48,
    cacheRead: 12_160,
    billable: 42_753,
    billingVersion: 2,
  };
  assert.equal(eventBillable(event, 'gpt'), 216);
});

test('invalid or excessive cached counts cannot create negative usage', () => {
  const counted = countCodexTokens({ input_tokens: 20, cached_input_tokens: 500, output_tokens: 3 });
  assert.equal(counted.cacheRead, 20);
  assert.equal(counted.promptTokens, 0);
  assert.equal(counted.billable, 3);
});
