export const BILLING_VERSION = 2;

const amount = (value) => {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

// Codex reports cached input as a subset of input_tokens. The cached harness,
// system prompt and previous context must not consume the product quota again.
export function countCodexTokens(usage = {}) {
  const input = amount(usage.input_tokens);
  const output = amount(usage.output_tokens);
  const cacheRead = Math.min(input, amount(usage.cached_input_tokens));
  return {
    input,
    output,
    cacheWrite: 0,
    cacheRead,
    total: input + output,
    billable: Math.max(0, input - cacheRead) + output,
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
  const oldBase = input + output;
  if (!cacheRead || !oldBase) return stored;

  const correctedBase = Math.max(0, input - cacheRead) + output;
  const appliedMultiplier = stored / oldBase;
  return Math.round(correctedBase * appliedMultiplier);
}
