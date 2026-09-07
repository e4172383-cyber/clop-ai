import { MODELS } from './config.js';

const WINDOW_MS = 60 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const THROUGHPUT_WINDOW_MS = RATE_WINDOW_MS;
const MAX_SAMPLES = 40;
const samples = { gpt: [], kimi: [] };

const finiteDuration = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
};

const finiteTokens = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
};

const roundedRate = (value, digits = 2) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

export function recordProviderResult(provider, result = {}) {
  if (!samples[provider]) return;
  samples[provider].push({
    ok: result.ok === true,
    at: Date.now(),
    durationMs: finiteDuration(result.durationMs),
    outputTokens: finiteTokens(result.tokens?.output),
  });
  samples[provider] = samples[provider].slice(-MAX_SAMPLES);
}

function recentSamples(provider, now) {
  samples[provider] = samples[provider].filter((sample) => now - sample.at <= WINDOW_MS);
  return samples[provider];
}

function providerSummary(provider, health, now, usageSamples = []) {
  const recent = recentSamples(provider, now);
  const successes = recent.filter((sample) => sample.ok);
  const last = recent.at(-1) || null;
  const lastSuccess = successes.at(-1) || null;
  const durations = successes.map((sample) => sample.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
  const medianMs = durations.length ? durations[Math.floor(durations.length / 2)] : null;
  const persisted = usageSamples
    .filter((sample) => sample.provider === provider && now - sample.at <= THROUGHPUT_WINDOW_MS)
    .map((sample) => ({
      at: Number(sample.at) || 0,
      durationMs: finiteDuration(sample.durationMs),
      outputTokens: finiteTokens(sample.outputTokens),
    }))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_SAMPLES);
  // Успешные события расхода лежат в Redis и переживают перезапуск Render.
  // Внутренние samples нужны как мгновенный запасной источник до сохранения.
  const metricSamples = persisted.length ? persisted : successes;
  const currentMinute = metricSamples.filter((sample) => now - sample.at <= RATE_WINDOW_MS);
  // Скорость отражает только ответы, завершённые за последнюю минуту.
  // Каждый ответ даёт свою фактическую пару «выходные токены / время», а
  // несколько сообщений в окне складываются в общую среднюю скорость.
  const throughput = currentMinute.filter((sample) => sample.durationMs > 0 && sample.outputTokens > 0);
  const outputTokens = throughput.reduce((total, sample) => total + sample.outputTokens, 0);
  const generationSeconds = throughput.reduce((total, sample) => total + sample.durationMs, 0) / 1000;
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
    requestsPerSecond: roundedRate(currentMinute.length / (RATE_WINDOW_MS / 1000), 3),
    tokensPerSecond: generationSeconds > 0 ? roundedRate(outputTokens / generationSeconds, 1) : 0,
    throughputSamples: throughput.length,
    throughputWindowSeconds: THROUGHPUT_WINDOW_MS / 1000,
  };
}

export function publicServiceStatus({ gptHealth, kimiHealth, processingMs = 0, usageSamples = [], now = Date.now() } = {}) {
  const providers = {
    gpt: providerSummary('gpt', gptHealth, now, usageSamples),
    kimi: providerSummary('kimi', kimiHealth, now, usageSamples),
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
  const providerValues = Object.values(providers);
  const requestRates = providerValues.map((provider) => provider.requestsPerSecond).filter(Number.isFinite);
  const tokenRates = providerValues.map((provider) => provider.tokensPerSecond).filter(Number.isFinite);
  return {
    ok: true,
    generatedAt: now,
    server: {
      status,
      statusText: status === 'operational' ? 'Все системы работают' : status === 'degraded' ? 'Есть временные сбои' : 'Часть систем недоступна',
      uptimeSeconds: Math.floor(process.uptime()),
      processingMs: finiteDuration(processingMs) || 0,
    },
    traffic: {
      requestsPerSecond: roundedRate(requestRates.reduce((sum, value) => sum + value, 0), 3),
      tokensPerSecond: roundedRate(tokenRates.reduce((sum, value) => sum + value, 0), 1),
      requestWindowSeconds: RATE_WINDOW_MS / 1000,
      throughputSamples: providerValues.reduce((sum, provider) => sum + provider.throughputSamples, 0),
      throughputWindowSeconds: THROUGHPUT_WINDOW_MS / 1000,
    },
    providers,
    models,
  };
}
