import test from 'node:test';
import assert from 'node:assert/strict';
import { API_PRICES, chargeMicros, purchaseBonus, starsToMicros } from '../src/billing.js';

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

test('Clop 4 pay as you go models have complete billing entries', () => {
  for (const model of ['clop-4-pulsar', 'clop-4-pro', 'clop-4-flash']) {
    assert.equal(typeof API_PRICES[model].title, 'string');
    assert.ok(chargeMicros(model, { input: 1000, output: 1000 }) > 0);
  }
});

test('purchases credit only four percent rounded down to whole bonuses', () => {
  assert.equal(purchaseBonus(25), 1);
  assert.equal(purchaseBonus(499), 19);
  assert.equal(purchaseBonus(999), 39);
  assert.equal(purchaseBonus(0), 0);
});
