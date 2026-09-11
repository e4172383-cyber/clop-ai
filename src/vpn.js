const CONTROL_URL = String(process.env.VPN_CONTROL_URL || '').replace(/\/$/, '');
const CONTROL_SECRET = String(process.env.VPN_CONTROL_SECRET || '');

export const VPN_PLANS = Object.freeze({
  free: Object.freeze({ key: 'free', title: 'Бесплатный', weeklyGb: 100, speedMbps: 50 }),
  go: Object.freeze({ key: 'go', title: 'GO', weeklyGb: 200, speedMbps: 100 }),
  pro: Object.freeze({ key: 'pro', title: 'Pro', weeklyGb: 250, speedMbps: 100 }),
  max: Object.freeze({ key: 'max', title: 'Max 5x', weeklyGb: 400, speedMbps: 150 }),
  max20: Object.freeze({ key: 'max20', title: 'Max 20x', weeklyGb: 750, speedMbps: 150 }),
  coderplus: Object.freeze({ key: 'coderplus', title: 'Coder+', weeklyGb: 1250, speedMbps: 500 }),
});

export function vpnPlan(planKey) {
  return VPN_PLANS[String(planKey || '')] || VPN_PLANS.free;
}

export function publicVpnPlan(planKey) {
  const plan = vpnPlan(planKey);
  return { ...plan, weeklyBytes: plan.weeklyGb * 1_000_000_000 };
}

export function vpnEnabled() {
  return Boolean(CONTROL_URL && CONTROL_SECRET);
}

export async function vpnControl(pathname, { method = 'GET', body, timeoutMs = 12_000 } = {}) {
  if (!vpnEnabled()) throw new Error('Clop VPN пока не включён на сервере.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`${CONTROL_URL}${pathname}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${CONTROL_SECRET}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      const error = new Error(result.error || `VPN-сервис вернул ошибку ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('VPN-сервис не ответил вовремя.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
