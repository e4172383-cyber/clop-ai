export const WEEK_LIMIT_MS = 60 * 60 * 1000;

export function weekStart(now = Date.now()) {
  const date = new Date(now);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

export function normalizedRecord(record = {}, now = Date.now()) {
  const start = weekStart(now);
  if (Number(record.weekStart) !== start) {
    return { weekStart: start, usedMs: 0, activeStartedAt: 0, containerId: '' };
  }
  return {
    weekStart: start,
    usedMs: Math.max(0, Number(record.usedMs) || 0),
    activeStartedAt: Math.max(0, Number(record.activeStartedAt) || 0),
    containerId: String(record.containerId || ''),
  };
}

export function settleRecord(record, now = Date.now()) {
  const next = normalizedRecord(record, now);
  if (next.activeStartedAt) {
    next.usedMs += Math.max(0, now - next.activeStartedAt);
    next.activeStartedAt = 0;
  }
  return next;
}

export function quotaView(record, now = Date.now()) {
  const current = normalizedRecord(record, now);
  const liveMs = current.activeStartedAt ? Math.max(0, now - current.activeStartedAt) : 0;
  const usedMs = Math.min(WEEK_LIMIT_MS, current.usedMs + liveMs);
  return {
    weekStart: current.weekStart,
    resetAt: current.weekStart + 7 * 24 * 60 * 60 * 1000,
    usedMs,
    remainingMs: Math.max(0, WEEK_LIMIT_MS - usedMs),
    percent: Math.min(100, Math.round(usedMs / WEEK_LIMIT_MS * 1000) / 10),
  };
}
