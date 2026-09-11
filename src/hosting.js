const GB = 1024 ** 3;

export function hostingQuota(planKey = 'free') {
  const coderPlus = String(planKey) === 'coderplus';
  return Object.freeze({
    planKey: coderPlus ? 'coderplus' : 'standard',
    ramBytes: coderPlus ? GB : Math.round(0.2 * GB),
    storageBytes: coderPlus ? 5 * GB : GB,
    cpuShare: coderPlus ? 0.05 : 0.025,
  });
}

export function hostingUsage(usedBytes, planKey = 'free') {
  const quota = hostingQuota(planKey);
  const used = Math.max(0, Number(usedBytes || 0));
  return {
    ...quota,
    usedBytes: used,
    leftBytes: Math.max(0, quota.storageBytes - used),
    percent: Math.min(100, Math.round((used / quota.storageBytes) * 1000) / 10),
  };
}
