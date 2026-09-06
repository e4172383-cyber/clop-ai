import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageJob, imageJobRecoveryAction, prepareImageJobRetry } from '../src/image-job.js';

test('a recent interrupted image job is retried once', () => {
  const now = 1_000_000;
  const job = createImageJob({ chatId: 42, prompt: 'Нарисуй море', placeholderMessageId: 7, now });
  assert.equal(imageJobRecoveryAction(job, now + 60_000), 'retry');
  const retried = prepareImageJobRetry(job, now + 60_000);
  assert.equal(retried.attempts, 2);
  assert.equal(imageJobRecoveryAction(retried, now + 61_000), 'notify');
});

test('a possibly delivered or stale image job is not duplicated', () => {
  const now = 2_000_000;
  const sending = { ...createImageJob({ chatId: 42, prompt: 'Кот', now }), stage: 'sending' };
  assert.equal(imageJobRecoveryAction(sending, now + 1000), 'notify');
  const stale = createImageJob({ chatId: 42, prompt: 'Кот', now: 1 });
  assert.equal(imageJobRecoveryAction(stale, now), 'notify');
  assert.equal(imageJobRecoveryAction({}, now), 'discard');
});
