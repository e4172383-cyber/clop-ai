import assert from 'node:assert/strict';
import test from 'node:test';
import { hostingQuota, hostingUsage } from '../src/hosting.js';

test('hosting resources use standard quota and expanded Coder+ quota', () => {
  const standard = hostingQuota('free');
  assert.equal(Math.round(standard.ramBytes / 1024 ** 2), 205);
  assert.equal(standard.storageBytes, 1024 ** 3);
  assert.equal(standard.cpuShare, 0.025);
  for (const plan of ['go', 'pro', 'max', 'max20']) assert.deepEqual(hostingQuota(plan), standard);

  const coder = hostingQuota('coderplus');
  assert.equal(coder.ramBytes, 1024 ** 3);
  assert.equal(coder.storageBytes, 5 * 1024 ** 3);
  assert.equal(coder.cpuShare, 0.05);
});

test('hosting usage is capped and reports remaining storage', () => {
  const state = hostingUsage(256 * 1024 ** 2, 'free');
  assert.equal(state.percent, 25);
  assert.equal(state.leftBytes, 768 * 1024 ** 2);
  assert.equal(hostingUsage(9 * 1024 ** 3, 'coderplus').percent, 100);
});
