import test from 'node:test';
import assert from 'node:assert/strict';
import { chargeMicros, starsToMicros } from '../src/billing.js';

test('pay as you go charges regular, cached and cache-write tokens at their own rates', () => {
  const charge = chargeMicros('gpt-astra', {
    input_tokens: 1_000_000,
    cached_input_tokens: 200_000,
    cache_creation_input_tokens: 100_000,
    output_tokens: 100_000,
  });
  // 700k * $10 + 200k * $1 + 100k * $12.50 + 100k * $50 = $13.45
  assert.equal(charge, 13_450_000);
});

test('86 Telegram Stars equal one dollar of API balance', () => {
  assert.equal(starsToMicros(86), 1_000_000);
});
