import test from 'node:test';
import assert from 'node:assert/strict';
import { addCounters, planFor, resetPeriod, WEEK_MS } from '../plans.mjs';

test('plan limits match the product specification', () => {
  assert.deepEqual(['free', 'go', 'pro', 'max', 'max20', 'coderplus'].map((key) => {
    const p = planFor(key);
    return [p.weeklyGb, p.speedMbps];
  }), [[100, 50], [200, 100], [250, 100], [400, 150], [750, 150], [1250, 500]]);
});

test('wireguard counters only add deltas and survive interface reset', () => {
  const peer = { uploadBytes: 10, downloadBytes: 20, lastReceivedBytes: 100, lastSentBytes: 200 };
  assert.equal(addCounters(peer, 140, 260), 130);
  assert.equal(addCounters(peer, 5, 7), 142);
});

test('weekly period resets usage', () => {
  const peer = { periodStartedAt: 1_000, uploadBytes: 99, downloadBytes: 80, disabled: true };
  assert.equal(resetPeriod(peer, 1_000 + WEEK_MS + 50), true);
  assert.equal(peer.uploadBytes, 0);
  assert.equal(peer.downloadBytes, 0);
  assert.equal(peer.disabled, false);
});
