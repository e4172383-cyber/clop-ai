import test from 'node:test';
import assert from 'node:assert/strict';
import { formatServerStatus, getServerMetrics } from '../src/server-metrics.js';

test('server status shows resource usage only as percentages', () => {
  const text = formatServerStatus({ cpu: 34, memory: 72, disk: 91 });
  assert.match(text, /Процессор[\s\S]*34%/);
  assert.match(text, /Память[\s\S]*72%/);
  assert.match(text, /Хранилище[\s\S]*91%/);
  assert.match(text, /Высокая нагрузка/);
  assert.doesNotMatch(text, /(?:ГБ|МБ|GB|MB|ядр|поток)/i);
});

test('live server metrics stay within valid percentage bounds', async () => {
  const metrics = await getServerMetrics();
  for (const key of ['cpu', 'memory', 'disk']) {
    assert.ok(Number.isInteger(metrics[key]));
    assert.ok(metrics[key] >= 0 && metrics[key] <= 100);
  }
});
