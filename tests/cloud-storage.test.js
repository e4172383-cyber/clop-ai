import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaForPlan } from '../src/cloud-storage.js';

test('cloud storage quotas match every personal plan', () => {
  const mb = 1024 * 1024;
  assert.equal(quotaForPlan('free'), 500 * mb);
  assert.equal(quotaForPlan('go'), 1000 * mb);
  assert.equal(quotaForPlan('pro'), 1750 * mb);
  assert.equal(quotaForPlan('max5'), 5000 * mb);
  assert.equal(quotaForPlan('max20'), 5000 * mb);
  assert.equal(quotaForPlan('coderplus'), 10 * 1024 * mb);
});
