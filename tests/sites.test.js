import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TOKEN_LIMITS_JSON ||= JSON.stringify(Object.fromEntries(
  ['free', 'go', 'pro', 'max', 'max20', 'coderplus'].map((plan) => [plan,
    Object.fromEntries(['claude', 'gpt', 'kimi', 'clop'].map((provider) => [provider, { short: 100, long: 1000 }]))]),
));

const sites = await import('../src/sites.js');
const sample = (title) => ({ files: { 'index.html': `<!doctype html><title>${title}</title><p>${title}</p>` }, entry: 'index.html' });

test('site limits are three on free and ten on every paid plan', () => {
  assert.equal(sites.siteLimit('free'), 3);
  for (const plan of ['go', 'pro', 'max', 'max20', 'coderplus']) assert.equal(sites.siteLimit(plan), 10);
});

test('free accounts cannot publish a fourth site while paid accounts can publish ten', async () => {
  const freeId = `sites-free-${Date.now()}`;
  for (let i = 1; i <= 3; i += 1) assert.equal((await sites.publish(freeId, sample(`Free ${i}`), 'free')).ok, true);
  const blocked = await sites.publish(freeId, sample('Free 4'), 'free');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /3 сайтов/);

  const paidId = `sites-paid-${Date.now()}`;
  for (let i = 1; i <= 10; i += 1) assert.equal((await sites.publish(paidId, sample(`Paid ${i}`), 'pro')).ok, true);
  const paidBlocked = await sites.publish(paidId, sample('Paid 11'), 'pro');
  assert.equal(paidBlocked.ok, false);
  assert.match(paidBlocked.error, /10 сайтов/);
});

test('only the owner can rename or delete a site', async () => {
  const owner = `sites-owner-${Date.now()}`;
  const made = await sites.publish(owner, sample('До переименования'), 'free');
  assert.equal(made.ok, true);
  assert.equal((await sites.renameSite('someone-else', made.slug, 'Чужое название')).ok, false);
  assert.equal(await sites.removeSite('someone-else', made.slug), false);
  assert.equal((await sites.renameSite(owner, made.slug, 'После переименования')).ok, true);
  assert.equal((await sites.listSites(owner))[0].title, 'После переименования');
  assert.equal(await sites.removeSite(owner, made.slug), true);
});
