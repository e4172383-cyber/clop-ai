const DEFAULT_LIMIT = Math.max(1, Number(process.env.MODEL_CONCURRENCY) || 1);
const DEFAULT_WAIT_MS = Math.max(10_000, Number(process.env.MODEL_QUEUE_WAIT_MS) || 90_000);
const DEFAULT_MAX_QUEUE = Math.max(1, Number(process.env.MODEL_MAX_QUEUE) || 20);

const busyResult = (message) => ({ ok: false, error: message });

export function createModelQueue({
  limit = DEFAULT_LIMIT,
  waitMs = DEFAULT_WAIT_MS,
  maxQueue = DEFAULT_MAX_QUEUE,
} = {}) {
  let active = 0;
  const waiting = [];

  function remove(rec) {
    const index = waiting.indexOf(rec);
    if (index >= 0) waiting.splice(index, 1);
  }

  function finishQueued(rec, result) {
    if (rec.done) return;
    rec.done = true;
    clearTimeout(rec.timer);
    rec.signal?.removeEventListener('abort', rec.abort);
    remove(rec);
    rec.resolve(result);
  }

  function pump() {
    while (active < limit && waiting.length) {
      const rec = waiting.shift();
      if (rec.done) continue;
      if (rec.signal?.aborted) {
        finishQueued(rec, busyResult('aborted'));
        continue;
      }

      rec.done = true;
      clearTimeout(rec.timer);
      rec.signal?.removeEventListener('abort', rec.abort);
      active += 1;
      Promise.resolve()
        .then(rec.task)
        .then((result) => {
          active -= 1;
          rec.resolve(result);
          pump();
        }, (error) => {
          active -= 1;
          rec.resolve(busyResult(String(error?.message || error)));
          pump();
        });
    }
  }

  function run(task, signal) {
    if (signal?.aborted) return Promise.resolve(busyResult('aborted'));
    if (waiting.length >= maxQueue) {
      return Promise.resolve(busyResult('Слишком много запросов одновременно. Попробуйте ещё раз через минуту.'));
    }

    return new Promise((resolve) => {
      const rec = { task, signal, resolve, done: false, timer: null, abort: null };
      rec.abort = () => finishQueued(rec, busyResult('aborted'));
      rec.timer = setTimeout(() => {
        finishQueued(rec, busyResult('Сервер занят другими ответами. Попробуйте ещё раз через минуту.'));
      }, waitMs);
      signal?.addEventListener('abort', rec.abort, { once: true });
      waiting.push(rec);
      pump();
    });
  }

  return {
    run,
    status: () => ({ active, waiting: waiting.filter((rec) => !rec.done).length, limit }),
  };
}

const shared = createModelQueue();
export const runModelJob = shared.run;
export const modelQueueStatus = shared.status;
