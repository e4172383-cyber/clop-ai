import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_WEEKLY_SECONDS, voiceLimitState, startVoiceSession, chargeVoiceHeartbeat, stopVoiceSession } from '../src/voice-limits.js';

test('voice plans have the requested weekly allowances', () => {
  assert.deepEqual(VOICE_WEEKLY_SECONDS, {
    free: 9000, go: 14400, pro: 21600, max: 43200, max20: 172800, coderplus: 230400,
  });
});

test('voice heartbeat charges server elapsed time and caps gaps', () => {
  const u = {};
  assert.ok(startVoiceSession(u, 'free', 's1', 1000));
  const first = chargeVoiceHeartbeat(u, 'free', 's1', 11_000);
  assert.equal(first.usedSeconds, 10);
  const capped = chargeVoiceHeartbeat(u, 'free', 's1', 111_000);
  assert.equal(capped.usedSeconds, 40);
  const stopped = stopVoiceSession(u, 'free', 's1', 116_000);
  assert.equal(stopped.usedSeconds, 45);
  assert.equal(u.voiceSessionId, undefined);
});

test('expired weekly voice usage is removed', () => {
  const week = 7 * 24 * 60 * 60 * 1000;
  const u = { voiceUsage: [{ id: 'old', startAt: 0, endAt: 1, seconds: 500 }] };
  assert.equal(voiceLimitState(u, 'pro', week + 2).usedSeconds, 0);
});
