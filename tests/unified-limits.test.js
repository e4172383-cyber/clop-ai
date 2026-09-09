import assert from 'node:assert/strict';
import test from 'node:test';

const plans = ['free', 'go', 'pro', 'max', 'max20', 'coderplus'];
const providers = ['claude', 'gpt', 'kimi', 'clop'];
process.env.TOKEN_LIMITS_JSON = JSON.stringify(Object.fromEntries(plans.map((plan) => [
  plan,
  Object.fromEntries(providers.map((provider) => [provider, { short: 1_000, long: 10_000 }])),
])));

const { PLANS, PLAN_LIMIT_MULTIPLIERS, MODELS } = await import('../src/config.js');
const store = await import('../src/store.js');
const { checkAllLimits, usedIn } = await import('../src/limits.js');

test('personal plan limits are derived from the free plan by one multiplier table', () => {
  assert.deepEqual(PLAN_LIMIT_MULTIPLIERS, {
    free: 1, go: 2, pro: 3.5, max: 14, max20: 59.5, coderplus: 196,
  });
  for (const [plan, multiplier] of Object.entries(PLAN_LIMIT_MULTIPLIERS)) {
    assert.equal(PLANS[plan].limits.shared.short, 1_000 * multiplier);
    assert.equal(PLANS[plan].limits.shared.long, 10_000 * multiplier);
    for (const provider of providers) {
      assert.deepEqual(PLANS[plan].limits[provider], PLANS[plan].limits.shared);
    }
  }
});

test('every published model has the intended shared-pool consumption weight', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(MODELS).map(([key, model]) => [key, model.limitMultiplier || 1])), {
    'kimi-k2-6': 1.5,
    'kimi-k2-7-code': 2,
    'kimi-k3': 3,
    'kimi-k3-swarm': 5,
    'gpt-astra': 6,
    'gpt-5-4-mini': 1,
    'gpt-5-5': 4,
    'gpt-luna': 1,
    'gpt-spark': 1.25,
    'gpt-terra': 2,
    'gpt-sol': 3.5,
    'clop-4-pulsar': 6,
    'clop-4-pro': 3.5,
    'clop-4-flash': 1.5,
  });
});

test('every model spends the same shared rolling windows', () => {
  const user = store.getUser({ id: 'shared-quota', first_name: 'Shared' });
  user.usage = [
    { ts: Date.now(), model: 'gpt-luna', billable: 200, total: 200, billingVersion: 3 },
    { ts: Date.now(), model: 'kimi-k2-6', billable: 300, total: 300, billingVersion: 3 },
    { ts: Date.now(), model: 'clop-4-pro', billable: 100, total: 100, billingVersion: 3 },
  ];

  assert.equal(usedIn(user, 5 * 60 * 60_000, 'gpt'), 600);
  assert.equal(usedIn(user, 5 * 60 * 60_000, 'kimi'), 600);
  const all = checkAllLimits(user);
  assert.equal(all.shared.states.find((state) => state.key === 'short').percent, 60);
  assert.equal(all.gpt, all.shared);
  assert.equal(all.kimi, all.shared);
  assert.equal(all.clop, all.shared);
});
