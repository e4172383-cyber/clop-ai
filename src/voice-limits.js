export const VOICE_WEEKLY_SECONDS = Object.freeze({
  free: Math.round(2.5 * 60 * 60),
  go: 4 * 60 * 60,
  pro: 6 * 60 * 60,
  max: 12 * 60 * 60,
  max20: 48 * 60 * 60,
  coderplus: 64 * 60 * 60,
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HEARTBEAT_CAP_SECONDS = 30;

function records(u) {
  if (!Array.isArray(u.voiceUsage)) u.voiceUsage = [];
  return u.voiceUsage;
}

export function voiceLimitState(u, planKey, now = Date.now()) {
  const cutoff = now - WEEK_MS;
  const usage = records(u);
  u.voiceUsage = usage.filter((e) => Number(e.endAt || e.startAt || 0) >= cutoff);
  const usedSeconds = u.voiceUsage.reduce((sum, e) => sum + Math.max(0, Number(e.seconds) || 0), 0);
  const limitSeconds = VOICE_WEEKLY_SECONDS[planKey] || VOICE_WEEKLY_SECONDS.free;
  return {
    usedSeconds: Math.round(usedSeconds),
    limitSeconds,
    leftSeconds: Math.max(0, Math.round(limitSeconds - usedSeconds)),
    percent: Math.min(100, Math.round(usedSeconds / limitSeconds * 100)),
    exceeded: usedSeconds >= limitSeconds,
  };
}

export function startVoiceSession(u, planKey, sessionId, now = Date.now()) {
  const state = voiceLimitState(u, planKey, now);
  if (state.exceeded) return null;
  const record = { id: String(sessionId), startAt: now, endAt: now, lastSeenAt: now, seconds: 0 };
  records(u).push(record);
  u.voiceSessionId = record.id;
  return record;
}

export function chargeVoiceHeartbeat(u, planKey, sessionId, now = Date.now()) {
  const usage = records(u);
  const record = usage.find((e) => e.id === String(sessionId));
  if (!record || u.voiceSessionId !== String(sessionId)) return null;
  const stateBefore = voiceLimitState(u, planKey, now);
  if (stateBefore.exceeded) return { ...stateBefore, ended: true };
  const elapsed = Math.max(0, (now - Number(record.lastSeenAt || now)) / 1000);
  const add = Math.min(HEARTBEAT_CAP_SECONDS, elapsed, stateBefore.leftSeconds);
  record.seconds = Math.max(0, Number(record.seconds) || 0) + add;
  record.endAt = now;
  record.lastSeenAt = now;
  const state = voiceLimitState(u, planKey, now);
  return { ...state, ended: state.exceeded };
}

export function stopVoiceSession(u, planKey, sessionId, now = Date.now()) {
  const state = chargeVoiceHeartbeat(u, planKey, sessionId, now) || voiceLimitState(u, planKey, now);
  if (u.voiceSessionId === String(sessionId)) delete u.voiceSessionId;
  return state;
}
