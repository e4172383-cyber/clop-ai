import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelQueue } from '../src/model-queue.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('model queue runs only one heavy process at a time', async () => {
  const queue = createModelQueue({ limit: 1, waitMs: 1_000, maxQueue: 5 });
  const first = deferred();
  const order = [];

  const a = queue.run(async () => {
    order.push('a:start');
    await first.promise;
    order.push('a:end');
    return { ok: true, text: 'a' };
  });
  const b = queue.run(async () => {
    order.push('b:start');
    return { ok: true, text: 'b' };
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.status(), { active: 1, waiting: 1, limit: 1 });
  assert.deepEqual(order, ['a:start']);

  first.resolve();
  assert.equal((await a).text, 'a');
  assert.equal((await b).text, 'b');
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start']);
});

test('queued model request can be cancelled without occupying a slot', async () => {
  const queue = createModelQueue({ limit: 1, waitMs: 1_000, maxQueue: 5 });
  const first = deferred();
  const a = queue.run(() => first.promise.then(() => ({ ok: true })));
  const controller = new AbortController();
  const b = queue.run(async () => ({ ok: true }), controller.signal);
  controller.abort();

  assert.deepEqual(await b, { ok: false, error: 'aborted' });
  first.resolve();
  await a;
  assert.deepEqual(queue.status(), { active: 0, waiting: 0, limit: 1 });
});
