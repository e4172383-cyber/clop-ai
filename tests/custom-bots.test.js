import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TOKEN_LIMITS_JSON ||= JSON.stringify(Object.fromEntries(
  ['free', 'go', 'pro', 'max', 'max20', 'coderplus'].map((plan) => [plan,
    Object.fromEntries(['claude', 'gpt', 'kimi', 'clop'].map((provider) => [provider, { short: 100, long: 1000 }]))]),
));

const { isPrivateNetworkAddress, validateOwnApiBaseUrl } = await import('../src/custom-bots.js');

test('custom bot API URLs reject local, private and metadata endpoints', async () => {
  for (const url of [
    'http://api.example.com',
    'https://localhost',
    'https://127.0.0.1:8443',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]',
    'https://user:secret@example.com',
    'https://example.com?redirect=https://127.0.0.1',
  ]) {
    await assert.rejects(validateOwnApiBaseUrl(url, async () => [{ address: '93.184.216.34' }]));
  }
  await assert.rejects(validateOwnApiBaseUrl('https://api.example.com', async () => [{ address: '10.0.0.5' }]));
});

test('custom bot API URL validation accepts a resolved public HTTPS service', async () => {
  const result = await validateOwnApiBaseUrl('https://api.example.com/base/', async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ]);
  assert.equal(result, 'https://api.example.com/base');
  assert.equal(isPrivateNetworkAddress('10.1.2.3'), true);
  assert.equal(isPrivateNetworkAddress('93.184.216.34'), false);
});
