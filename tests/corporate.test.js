import assert from 'node:assert/strict';
import test from 'node:test';

const planKeys = ['free', 'go', 'pro', 'max', 'max20', 'coderplus'];
const providers = ['claude', 'gpt', 'kimi', 'clop'];
process.env.TOKEN_LIMITS_JSON = JSON.stringify(Object.fromEntries(planKeys.map((key) => [
  key, Object.fromEntries(providers.map((provider) => [provider, { short: 100, long: 1000 }])),
])));
process.env.CORPORATE_LIMITS_JSON = JSON.stringify({
  corp1: { short: 500, long: 1_000 },
  corp2: { short: 750, long: 2_000 },
  corp3: { short: 1_000, long: 3_000 },
  corp4: { short: 2_000, long: 4_000 },
});

const store = await import('../src/store.js');
const limits = await import('../src/limits.js');

function user(id, username) {
  const u = store.getUser({ id, username, first_name: username });
  store.markStarted(u);
  return u;
}

test('corporate invitation requires /start and explicit acceptance', () => {
  const owner = user('corp-owner', 'owner');
  const inactive = store.getUser({ id: 'corp-inactive', username: 'inactive' });
  store.grantCorporatePlan(owner, 'corp1', 30);

  assert.equal(store.inviteToTeam(owner, inactive).ok, false);
  store.markStarted(inactive);
  const invitation = store.inviteToTeam(owner, inactive);
  assert.equal(invitation.ok, true);
  assert.equal(store.activeTeamFor(inactive), null);

  const accepted = store.respondToTeamInvite(inactive, invitation.invite.id, true);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.accepted, true);
  assert.equal(store.activeTeamFor(inactive).id, invitation.team.id);
  assert.equal(invitation.team.members.length, 2);
});

test('corporate short window is per member and weekly window is shared across providers', () => {
  const owner = user('quota-owner', 'quotaowner');
  const member = user('quota-member', 'quotamember');
  store.grantCorporatePlan(owner, 'corp1', 30);
  const invitation = store.inviteToTeam(owner, member);
  store.respondToTeamInvite(member, invitation.invite.id, true);

  owner.usage.push({ ts: Date.now(), model: 'gpt-luna', billable: 400, total: 400, billingVersion: 3 });
  member.usage.push({ ts: Date.now(), model: 'kimi-k2-6', billable: 500, total: 500 });

  const ownerState = limits.checkLimits(owner, 'gpt');
  const memberState = limits.checkLimits(member, 'kimi');
  assert.equal(ownerState.states.find((x) => x.key === 'short').percent, 20);
  assert.equal(memberState.states.find((x) => x.key === 'short').blocked, undefined);
  assert.equal(memberState.states.find((x) => x.key === 'short').percent, 50);
  assert.equal(memberState.states.find((x) => x.key === 'short').exceeded, false);
  assert.equal(ownerState.states.find((x) => x.key === 'long').percent, 35);
  assert.equal(memberState.states.find((x) => x.key === 'long').percent, 35);
  assert.equal(memberState.blocked, null);
});

test('team capacity includes owner and a declined invitation never occupies a seat', () => {
  const owner = user('cap-owner', 'capowner');
  store.grantCorporatePlan(owner, 'corp1', 30);
  const declinedUser = user('cap-decline', 'capdecline');
  const declined = store.inviteToTeam(owner, declinedUser);
  store.respondToTeamInvite(declinedUser, declined.invite.id, false);

  for (let i = 0; i < 4; i++) {
    const member = user(`cap-${i}`, `cap${i}`);
    const invitation = store.inviteToTeam(owner, member);
    assert.equal(invitation.ok, true);
    assert.equal(store.respondToTeamInvite(member, invitation.invite.id, true).ok, true);
  }
  const extra = user('cap-extra', 'capextra');
  assert.match(store.inviteToTeam(owner, extra).error, /максимум/);
});
