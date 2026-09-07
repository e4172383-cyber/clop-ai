const MICRO = 1_000_000;
export const STARS_PER_USD = 86;
export const MIN_TOPUP_STARS = 86;
export const MAX_TOPUP_STARS = 43_000;

export const API_PRICES = Object.freeze({
  'gpt-astra': { title: 'GPT-6 Astra', input: 2.5, cachedInput: .25, cacheWrite: 3.125, output: 12.5, discountPercent: 75 },
  'gpt-sol': { title: 'GPT 5.6 Sol', input: 4, cachedInput: .4, output: 20 },
  'gpt-terra': { title: 'GPT 5.6 Terra', input: 2, cachedInput: .2, output: 12 },
  'gpt-luna': { title: 'GPT 5.6 Luna', input: .2, cachedInput: .02, output: 1.2 },
  'clop-3-1-pulsar': { title: 'Clop 3.1 Pulsar', input: 2.5, cachedInput: .25, cacheWrite: 3.125, output: 12.5 },
  'clop-3-1-opus': { title: 'Clop 3.1 Opus', input: 4, cachedInput: .4, output: 20 },
  'clop-3-1-haiku': { title: 'Clop 3.1 Haiku', input: 4, cachedInput: .4, output: 20 },
  'gpt-image-2-5': { title: 'GPT Image 2.5', input: 8, output: 8 },
  'kimi-k3': { title: 'Kimi K3', input: 2.55, output: 12.75 },
  'kimi-k2-6': { title: 'Kimi K2.6', input: .56, output: 3.39 },
  'kimi-k2-7-code': { title: 'Kimi K2.7 Code', input: .66, output: 3.4 },
});

const amount = (value) => Math.max(0, Number(value || 0));
export function chargeMicros(model, usage = {}) {
  const p = API_PRICES[model];
  if (!p) return null;
  const input = amount(usage.input_tokens ?? usage.input);
  const output = amount(usage.output_tokens ?? usage.output);
  const cached = Math.min(input, amount(usage.cached_input_tokens ?? usage.cacheRead));
  const cacheWrite = amount(usage.cache_creation_input_tokens ?? usage.cacheWrite);
  const regularInput = Math.max(0, input - cached - cacheWrite);
  const dollars = (regularInput * p.input + cached * (p.cachedInput ?? p.input) + cacheWrite * (p.cacheWrite ?? p.input) + output * p.output) / 1_000_000;
  return Math.max(1, Math.round(dollars * MICRO));
}

export const microsToUsd = (micros) => Math.max(0, Number(micros || 0)) / MICRO;
export const starsToMicros = (stars) => Math.round((Number(stars) / STARS_PER_USD) * MICRO);
