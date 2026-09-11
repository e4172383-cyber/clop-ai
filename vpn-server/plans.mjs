export const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
export const GB = 1_000_000_000;

export const PLANS = Object.freeze({
  free: Object.freeze({ key: 'free', weeklyGb: 100, speedMbps: 50 }),
  go: Object.freeze({ key: 'go', weeklyGb: 200, speedMbps: 100 }),
  pro: Object.freeze({ key: 'pro', weeklyGb: 250, speedMbps: 100 }),
  max: Object.freeze({ key: 'max', weeklyGb: 400, speedMbps: 150 }),
  max20: Object.freeze({ key: 'max20', weeklyGb: 750, speedMbps: 150 }),
  coderplus: Object.freeze({ key: 'coderplus', weeklyGb: 1250, speedMbps: 500 }),
});

export function planFor(key) {
  const plan = PLANS[String(key || '')] || PLANS.free;
  return { ...plan, weeklyBytes: plan.weeklyGb * GB };
}

export function resetPeriod(peer, now = Date.now()) {
  const startedAt = Number(peer.periodStartedAt || now);
  if (now - startedAt < WEEK_MS) return false;
  const periods = Math.max(1, Math.floor((now - startedAt) / WEEK_MS));
  peer.periodStartedAt = startedAt + periods * WEEK_MS;
  peer.uploadBytes = 0;
  peer.downloadBytes = 0;
  peer.disabled = false;
  return true;
}

export function addCounters(peer, receivedBytes, sentBytes) {
  const received = Math.max(0, Number(receivedBytes) || 0);
  const sent = Math.max(0, Number(sentBytes) || 0);
  const lastReceived = Math.max(0, Number(peer.lastReceivedBytes) || 0);
  const lastSent = Math.max(0, Number(peer.lastSentBytes) || 0);
  peer.uploadBytes = Math.max(0, Number(peer.uploadBytes) || 0) + (received >= lastReceived ? received - lastReceived : received);
  peer.downloadBytes = Math.max(0, Number(peer.downloadBytes) || 0) + (sent >= lastSent ? sent - lastSent : sent);
  peer.lastReceivedBytes = received;
  peer.lastSentBytes = sent;
  return peer.uploadBytes + peer.downloadBytes;
}
