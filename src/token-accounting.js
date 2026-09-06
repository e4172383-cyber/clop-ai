export const BILLING_VERSION = 3;

const amount = (value) => {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

// Codex reports cached input as a subset of input_tokens. The cached harness,
// system prompt and previous context must not consume the product quota again.
export function estimateTextTokens(text = '') {
  const value = String(text || '');
  if (!value) return 0;
  // UTF-8 bytes give a closer neutral approximation for both Russian and
  // English than JS string length. The provider only reports the whole
  // resumed context, so the current user message has to be isolated here.
  return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 4));
}

export function countCodexTokens(usage = {}, { prompt, imageCount = 0 } = {}) {
  const input = amount(usage.input_tokens);
  const output = amount(usage.output_tokens);
  const cacheRead = Math.min(input, amount(usage.cached_input_tokens));
  const measuredInput = Math.max(0, input - cacheRead);
  const hasPrompt = prompt !== undefined && prompt !== null;
  const freshInput = hasPrompt
    ? Math.min(input || Infinity, estimateTextTokens(prompt) + Math.max(0, Number(imageCount) || 0) * 1_000)
    : measuredInput;
  return {
    input,
    output,
    cacheWrite: 0,
    cacheRead,
    total: input + output,
    promptTokens: Number.isFinite(freshInput) ? freshInput : 0,
    billable: (Number.isFinite(freshInput) ? freshInput : 0) + output,
  };
}

// Version 1 stored input+output for GPT even though cached_input_tokens was
// already included in input. Reconstruct the multiplier and correct those
// saved events at read time, so existing users do not keep the inflated usage.
export function eventBillable(event = {}, provider = '') {
  const stored = amount(event.billable ?? event.total);
  if (provider !== 'gpt' || Number(event.billingVersion || 0) >= BILLING_VERSION) return stored;

  const input = amount(event.input);
  const output = amount(event.output);
  const cacheRead = Math.min(input, amount(event.cacheRead));
  const nonCachedInput = Math.max(0, input - cacheRead);
  const version = Number(event.billingVersion || 0);
  const previouslyCountedBase = version >= 2 ? nonCachedInput + output : input + output;
  if (!previouslyCountedBase) return stored;

  // Старые записи не содержат размер конкретного сообщения. Консервативно
  // отделяем его от многократно присланного контекста по размеру ответа.
  const inferredFreshInput = Math.min(nonCachedInput, Math.max(256, output * 8));
  const correctedBase = inferredFreshInput + output;
  const appliedMultiplier = stored / previouslyCountedBase;
  return Math.round(correctedBase * appliedMultiplier);
}
