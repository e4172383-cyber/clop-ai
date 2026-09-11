'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { profileText } = require('../src/tunnel.cjs');

test('WireGuard profile routes all traffic through Clop Germany', () => {
  const key = Buffer.alloc(32, 1).toString('base64');
  const serverKey = Buffer.alloc(32, 2).toString('base64');
  const text = profileText(key, {
    serverPublicKey: serverKey,
    address: '10.77.0.8/32',
    endpoint: '195.201.169.74:51820',
    dns: ['1.1.1.1', '1.0.0.1'],
  });
  assert.match(text, /AllowedIPs = 0\.0\.0\.0\/0/);
  assert.match(text, /::\/0/);
  assert.match(text, /Endpoint = 195\.201\.169\.74:51820/);
  assert.match(text, /PersistentKeepalive = 25/);
  assert.doesNotMatch(text, /undefined/);
});

test('WireGuard profile rejects an invalid server response', () => {
  const key = Buffer.alloc(32, 1).toString('base64');
  assert.throws(() => profileText(key, { serverPublicKey: 'bad', address: '10.77.0.8/32', endpoint: 'server:51820' }));
});
