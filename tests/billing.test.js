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
  // После скидки 75%: 700k * $2.50 + 200k * $0.25
  // + 100k * $3.125 + 100k * $12.50 = $3.3625.
  assert.equal(charge, 3_362_500);
});

test('86 Telegram Stars equal one dollar of API balance', () => {
  assert.equal(starsToMicros(86), 1_000_000);
});
