const RETRY_WINDOW_MS = 30 * 60 * 1000;

export function createImageJob({ chatId, prompt, placeholderMessageId, now = Date.now() }) {
  return {
    chatId: String(chatId),
    prompt: String(prompt || '').trim().slice(0, 4000),
    placeholderMessageId: Number(placeholderMessageId) || null,
    startedAt: now,
    attempts: 1,
    stage: 'generating',
  };
}

export function imageJobRecoveryAction(job, now = Date.now()) {
  if (!job || !job.chatId || !job.prompt) return 'discard';
  if (job.stage === 'sending') return 'notify';
  const age = now - Number(job.startedAt || 0);
  if (age < 0 || age > RETRY_WINDOW_MS) return 'notify';
  if (Number(job.attempts || 1) >= 2) return 'notify';
  return 'retry';
}

export function prepareImageJobRetry(job, now = Date.now()) {
  return {
    ...job,
    startedAt: now,
    attempts: Number(job.attempts || 1) + 1,
    stage: 'generating',
  };
}
