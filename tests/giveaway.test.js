import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_TEST_CONTEXT = '1';
const plans = ['free', 'go', 'pro', 'max', 'max20', 'coderplus'];
const providers = ['claude', 'gpt', 'kimi', 'clop'];
process.env.TOKEN_LIMITS_JSON = JSON.stringify(Object.fromEntries(plans.map((plan) => [
  plan,
  Object.fromEntries(providers.map((provider) => [provider, { short: 1000, long: 10_000 }])),
])));

const store = await import('../src/store.js');
const { PRO_GIVEAWAY, drawGiveaway, giveawayState, initializeGiveaway, joinGiveaway } = await import('../src/giveaway.js');

test('Pro giveaway starts with 71 real accounts, accepts one entry and ends exactly after 14 hours', async () => {
  await store.load();
  for (let i = 0; i < 72; i++) {
    store.getUser({ id: 100000 + i, first_name: `User ${i}`, username: `user_${i}` });
  }
  const startedAt = Date.now();
  initializeGiveaway(startedAt);
  const initial = giveawayState(null, startedAt);
  assert.equal(initial.participants, 71);
  assert.equal(initial.endsAt - initial.startedAt, 14 * 60 * 60_000);

  const extra = store.findUser('100000');
  const before = giveawayState(extra, startedAt);
  if (!before.joined) {
    const joined = joinGiveaway(extra, startedAt + 1000);
    assert.equal(joined.ok, true);
    assert.equal(joined.alreadyJoined, false);
    assert.equal(joined.state.participants, 72);
    assert.equal(joinGiveaway(extra, startedAt + 2000).state.participants, 72);
  }

  assert.equal(drawGiveaway(initial.endsAt - 1).reason, 'active');
  const result = drawGiveaway(initial.endsAt, () => 0);
  assert.equal(result.ok, true);
  assert.equal(result.justDrawn, true);
  const winner = store.findUser(result.winner.userId);
  assert.equal(winner.plan, 'pro');
  assert.equal(winner.proUntil, initial.endsAt + PRO_GIVEAWAY.prizeDays * 24 * 60 * 60_000);
  assert.equal(drawGiveaway(initial.endsAt + 1, () => 1).winner.userId, result.winner.userId);
});
