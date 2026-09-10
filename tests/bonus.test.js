import assert from 'node:assert/strict';
import test from 'node:test';

const plans = ['free', 'go', 'pro', 'max', 'max20', 'coderplus'];
const providers = ['claude', 'gpt', 'kimi', 'clop'];
process.env.TOKEN_LIMITS_JSON = JSON.stringify(Object.fromEntries(plans.map((plan) => [
  plan, Object.fromEntries(providers.map((provider) => [provider, { short: 1_000, long: 10_000 }])),
])));
process.env.CORPORATE_LIMITS_JSON = JSON.stringify(Object.fromEntries(['corp1', 'corp2', 'corp3', 'corp4'].map((plan) => [
  plan, { short: 1_000, long: 10_000 },
])));

const store = await import('../src/store.js');
const limits = await import('../src/limits.js');

test('bonus reservations create a real discount and can be consumed or returned', () => {
  const user = store.getUser({ id: 'bonus-reservation', first_name: 'Bonus' });
  store.addBonus(user, 100, { sourceId: 'reward-one', reason: 'Награда' });
  store.addBonus(user, 100, { sourceId: 'reward-one', reason: 'Дубликат' });
  assert.equal(store.bonusBalance(user), 100);

  const reservation = store.reserveBonus(user, 75, 60_000);
  assert.equal(reservation.amount, 75);
  assert.equal(store.bonusBalance(user), 25);
  assert.equal(store.consumeBonusReservation(user, reservation.id, { reason: 'Скидка' }), 75);
  assert.equal(store.bonusReport(user).transactions[0].amount, -75);

  const returned = store.reserveBonus(user, 20, 60_000);
  assert.equal(store.releaseBonusReservation(user, returned.id), 20);
  assert.equal(store.bonusBalance(user), 25);
});

test('the five-hour reset preserves weekly usage', () => {
  const user = store.getUser({ id: 'bonus-reset', first_name: 'Reset' });
  user.usage = [{ ts: Date.now() - 1_000, model: 'gpt-luna', billable: 400, total: 400, billingVersion: 3 }];
  assert.equal(limits.usedIn(user, 5 * 60 * 60_000, 'gpt'), 200);
  assert.equal(limits.usedIn(user, 7 * 24 * 60 * 60_000, 'gpt'), 200);
  store.resetFiveHourUsage(user, { reason: 'Награда за баг', sourceId: 'bug:1' });
  assert.equal(limits.usedIn(user, 5 * 60 * 60_000, 'gpt'), 0);
  assert.equal(limits.usedIn(user, 7 * 24 * 60 * 60_000, 'gpt'), 200);
});
