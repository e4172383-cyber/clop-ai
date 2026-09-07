import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.WEB_SESSION_SECRET = 'desktop-pairing-test-secret';
const plans = ['free', 'go', 'pro', 'max', 'max20', 'coderplus'];
const providers = ['claude', 'gpt', 'kimi', 'clop'];
process.env.TOKEN_LIMITS_JSON = JSON.stringify(Object.fromEntries(plans.map((plan) => [
  plan,
  Object.fromEntries(providers.map((provider) => [provider, { short: 100, long: 100 }])),
])));

const { claimPair, initPair, redeemPair } = await import('../src/desktop.js');
const { raw } = await import('../src/store.js');

test('Clop Code pairing accepts the desktop code and base64url secret hash', () => {
  const code = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const secretHash = crypto.createHash('sha256').update(secret).digest('base64url');

  assert.equal(initPair(code, secretHash, 'Clop Code test'), true);
  assert.equal(raw().desktopPairs[code].secretHash, secretHash,
    'the pending login is kept in the durable store snapshot');
  assert.equal(initPair(code, crypto.randomBytes(32).toString('base64url'), 'attacker'), false,
    'an active pairing code cannot be overwritten');
  assert.equal(claimPair(code, 'telegram-user-test'), true);
  assert.equal(raw().desktopPairs[code].userId, 'telegram-user-test',
    'Telegram confirmation is persisted before the app returns');
  assert.deepEqual(redeemPair(code, secret), {
    userId: 'telegram-user-test',
    device: 'Clop Code test',
  });
  assert.equal(redeemPair(code, secret), null, 'pair is single-use');
  assert.equal(raw().desktopPairs[code], undefined, 'redeemed login is removed from the store');
});
