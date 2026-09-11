import test from 'node:test';
import assert from 'node:assert/strict';
import { publicVpnPlan, vpnPlan } from '../src/vpn.js';

test('VPN plans use the requested weekly traffic and speed limits', () => {
  assert.deepEqual(Object.fromEntries(['free', 'go', 'pro', 'max', 'max20', 'coderplus'].map((key) => {
    const plan = vpnPlan(key);
    return [key, [plan.weeklyGb, plan.speedMbps]];
  })), {
    free: [100, 50], go: [200, 100], pro: [250, 100], max: [400, 150], max20: [750, 150], coderplus: [1250, 500],
  });
  assert.equal(publicVpnPlan('coderplus').weeklyBytes, 1_250_000_000_000);
});

test('unknown plans safely receive the free VPN policy', () => {
  assert.equal(vpnPlan('unknown').key, 'free');
});
