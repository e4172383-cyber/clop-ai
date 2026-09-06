import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { claimPair, initPair, redeemPair } from './desktop.js';

test('Clop Code pairing accepts the desktop code and base64url secret hash', () => {
  const code = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const secretHash = crypto.createHash('sha256').update(secret).digest('base64url');

  assert.equal(initPair(code, secretHash, 'Clop Code test'), true);
  assert.equal(initPair(code, crypto.randomBytes(32).toString('base64url'), 'attacker'), false,
    'an active pairing code cannot be overwritten');
  assert.equal(claimPair(code, 'telegram-user-test'), true);
  assert.deepEqual(redeemPair(code, secret), {
    userId: 'telegram-user-test',
    device: 'Clop Code test',
  });
  assert.equal(redeemPair(code, secret), null, 'pair is single-use');
});
