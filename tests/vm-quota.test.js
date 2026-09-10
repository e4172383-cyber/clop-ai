import test from 'node:test';
import assert from 'node:assert/strict';
import { WEEK_LIMIT_MS, weekStart, normalizedRecord, settleRecord, quotaView } from '../vm-manager/quota.js';

test('VM week starts on Monday UTC and resets stale usage', () => {
  const wednesday = Date.UTC(2026, 8, 9, 12);
  assert.equal(weekStart(wednesday), Date.UTC(2026, 8, 7));
  const record = normalizedRecord({ weekStart: Date.UTC(2026, 7, 31), usedMs: 99_000 }, wednesday);
  assert.equal(record.usedMs, 0);
});

test('active VM time is counted and capped at one hour per week', () => {
  const now = Date.UTC(2026, 8, 9, 12);
  const record = { weekStart: weekStart(now), usedMs: 10 * 60_000, activeStartedAt: now - 20 * 60_000 };
  const view = quotaView(record, now);
  assert.equal(view.usedMs, 30 * 60_000);
  assert.equal(view.remainingMs, 30 * 60_000);
  assert.equal(view.percent, 50);
  const settled = settleRecord(record, now + WEEK_LIMIT_MS);
  assert.equal(quotaView(settled, now + WEEK_LIMIT_MS).remainingMs, 0);
});
