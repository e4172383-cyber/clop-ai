'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SERVER, normalizeServerUrl, resolveServer, trustedUpdateUrl } = require('../src/server-config.cjs');

test('remote server configuration changes the API without reinstalling the app', async () => {
  const result = await resolveServer({
    env: {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ apiBase: 'https://clop-api.example.com/' }) }),
  });
  assert.deepEqual(result, { url: 'https://clop-api.example.com', source: 'remote-config' });
});

test('server configuration rejects paths, credentials and non-HTTPS URLs', () => {
  assert.equal(normalizeServerUrl('http://example.com'), '');
  assert.equal(normalizeServerUrl('https://user:pass@example.com'), '');
  assert.equal(normalizeServerUrl('https://example.com/api'), '');
  assert.equal(normalizeServerUrl('https://example.com/'), 'https://example.com');
});

test('server resolution falls back to the bundled address when config is unavailable', async () => {
  const result = await resolveServer({ env: {}, fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(result, { url: DEFAULT_SERVER, source: 'bundled-fallback' });
});

test('updates accept only the configured server or the official GitHub release', () => {
  assert.equal(trustedUpdateUrl('https://github.com/e4172383-cyber/clop-ai/releases/download/v2.4.1/Clop-Code-Setup-2.4.1.exe'), true);
  assert.equal(trustedUpdateUrl('https://clop.example.com/downloads/Clop-Code-Setup-2.4.1.exe', { serverBase: 'https://clop.example.com' }), true);
  assert.equal(trustedUpdateUrl('https://attacker.example/Clop-Code-Setup-2.4.1.exe'), false);
  assert.equal(trustedUpdateUrl('https://github.com/other/project/releases/download/v1/Clop-Code-Setup-2.4.1.exe'), false);
});
