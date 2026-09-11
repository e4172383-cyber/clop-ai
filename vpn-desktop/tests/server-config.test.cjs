'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeServerUrl } = require('../src/server-config.cjs');

test('server config accepts only an HTTPS origin', () => {
  assert.equal(normalizeServerUrl('https://clop.example.com'), 'https://clop.example.com');
  assert.equal(normalizeServerUrl('http://clop.example.com'), '');
  assert.equal(normalizeServerUrl('https://clop.example.com/path'), '');
  assert.equal(normalizeServerUrl('https://user:pass@clop.example.com'), '');
});
