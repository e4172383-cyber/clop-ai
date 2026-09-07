import { MODELS } from './config.js';

const WINDOW_MS = 60 * 60 * 1000;
const MAX_SAMPLES = 40;
const samples = { gpt: [], kimi: [] };

const finiteDuration = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
};

export function recordProviderResult(provider, result = {}) {
  if (!samples[provider]) return;
  samples[provider].push({
    ok: result.ok === true,
    at: Date.now(),
    durationMs: finiteDuration(result.durationMs),
  });
  samples[provider] = samples[provider].slice(-MAX_SAMPLES);
}

function recentSamples(provider, now) {
  samples[provider] = samples[provider].filter((sample) => now - sample.at <= WINDOW_MS);
  return samples[provider];
}

function providerSummary(provider, health, now) {
  const recent = recentSamples(provider, now);
  const successes = recent.filter((sample) => sample.ok);
  const last = recent.at(-1) || null;
  const lastSuccess = successes.at(-1) || null;
  const durations = successes.map((sample) => sample.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
  const medianMs = durations.length ? durations[Math.floor(durations.length / 2)] : null;
  let status = health?.ok ? 'operational' : 'unavailable';
  if (health?.ok && last && !last.ok && now - last.at < 10 * 60 * 1000) status = 'degraded';
  return {
    key: provider,
    title: provider === 'gpt' ? 'GPT' : 'Kimi',
    status,
    statusText: status === 'operational' ? 'Работает' : status === 'degraded' ? 'Есть сбои' : 'Недоступен',
    checkedAt: now,
    lastSuccessAt: lastSuccess?.at || null,
    lastResponseMs: lastSuccess?.durationMs ?? null,
    medianResponseMs: medianMs,
    recentRequests: recent.length,
    recentSuccessPercent: recent.length ? Math.round((successes.length / recent.length) * 100) : null,
  };
}

export function publicServiceStatus({ gptHealth, kimiHealth, processingMs = 0, now = Date.now() } = {}) {
  const providers = {
    gpt: providerSummary('gpt', gptHealth, now),
    kimi: providerSummary('kimi', kimiHealth, now),
  };
  const models = Object.values(MODELS)
    .filter((model) => model.provider === 'gpt' || model.provider === 'kimi')
    .map((model) => ({
      key: model.key,
      title: model.title,
      provider: model.provider,
      description: model.desc,
      status: providers[model.provider].status,
      statusText: providers[model.provider].statusText,
      access: model.plans.includes('free') ? 'Доступна всем' : model.plans.includes('go') ? 'От тарифа GO' : 'От тарифа Pro',
    }));
  const statuses = Object.values(providers).map((provider) => provider.status);
  const status = statuses.includes('unavailable') ? 'partial' : statuses.includes('degraded') ? 'degraded' : 'operational';
  return {
    ok: true,
    generatedAt: now,
    server: {
      status,
      statusText: status === 'operational' ? 'Все системы работают' : status === 'degraded' ? 'Есть временные сбои' : 'Часть систем недоступна',
      uptimeSeconds: Math.floor(process.uptime()),
      processingMs: finiteDuration(processingMs) || 0,
    },
    providers,
    models,
  };
}

