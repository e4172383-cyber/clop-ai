'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAntigravityQuotaReport, parseCodexQuotaResponse } = require('../src/provider-quotas.cjs');

test('normalizes real Codex five-hour and weekly windows from multi-bucket response', () => {
  const quota = parseCodexQuotaResponse({ result: { rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { usedPercent: 96, windowDurationMins: 10080, resetsAt: 1789455674 }, planType: 'pro' },
    spark: {
      limitId: 'spark', limitName: 'GPT Spark',
      primary: { usedPercent: 36, windowDurationMins: 300, resetsAt: 1789151239 },
      secondary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: 1789738039 },
    },
  } } }, 1234);
  assert.equal(quota.status, 'ok');
  assert.equal(quota.updatedAt, 1234);
  assert.equal(quota.groups[0].title, 'GPT Spark');
  assert.deepEqual(quota.groups[0].windows.map((item) => [item.title, item.usedPercent, item.remainingPercent]), [
    ['5 часов', 36, 64], ['Неделя', 16, 84],
  ]);
  assert.equal(quota.groups[1].windows[0].resetsAt, 1789455674000);
});

test('parses Antigravity quota report without treating remaining as used', () => {
  const report = [
    'Gemini Models',
    'Five Hour Limit Remaining 72%',
    'Refreshes in 2h 10m',
    'Weekly Limit Remaining 48% 2026-09-15T10:30:00Z',
    'Claude and GPT models\tFive Hour Limit Remaining\t90%\t2026-09-11T22:00:00Z',
    'Claude and GPT models\tWeekly Limit Remaining\t25%\t2026-09-18T19:00:00Z',
  ].join('\n');
  const quota = parseAntigravityQuotaReport(report, 5678);
  assert.equal(quota.updatedAt, 5678);
  assert.deepEqual(quota.groups[0].windows.map((item) => item.usedPercent), [28, 52]);
  assert.equal(quota.groups[0].windows[0].resetText, '2h 10m');
  assert.deepEqual(quota.groups[1].windows.map((item) => item.remainingPercent), [90, 25]);
  assert.equal(quota.groups[1].windows[0].resetsAt, Date.parse('2026-09-11T22:00:00Z'));
});

test('rejects quota output that contains no real percentages', () => {
  assert.throws(() => parseAntigravityQuotaReport('Please sign in first'), /не вернул квоту/i);
  assert.throws(() => parseCodexQuotaResponse({ result: {} }), /не вернул доступные окна/i);
});
