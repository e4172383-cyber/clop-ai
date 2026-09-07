const DEFAULT_WINDOWS = ['short', 'long'];

function invalid(message) {
  return new Error(`Invalid TOKEN_LIMITS_JSON: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateKeyList(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw invalid(`${name} schema is empty`);
  if (value.some((key) => typeof key !== 'string' || key.length === 0)) {
    throw invalid(`${name} schema contains an invalid key`);
  }
  if (new Set(value).size !== value.length) throw invalid(`${name} schema contains duplicate keys`);
  return value;
}

function validateExactObject(value, expectedKeys, path) {
  if (!isPlainObject(value)) throw invalid(`${path} must be an object`);
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(value, key))) {
    throw invalid(`${path} must contain exactly the configured keys`);
  }
}

export function parseTokenLimits(raw, schema) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('TOKEN_LIMITS_JSON is required');

  const plans = validateKeyList(schema?.plans, 'plans');
  const providers = validateKeyList(schema?.providers, 'providers');
  const windows = validateKeyList(schema?.windows || DEFAULT_WINDOWS, 'windows');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid('value must be valid JSON');
  }

  validateExactObject(parsed, plans, 'root');
  const result = {};
  for (const plan of plans) {
    validateExactObject(parsed[plan], providers, plan);
    const planResult = {};
    for (const provider of providers) {
      const path = `${plan}.${provider}`;
      validateExactObject(parsed[plan][provider], windows, path);
      const providerResult = {};
      for (const window of windows) {
        const value = parsed[plan][provider][window];
        if (value === null) {
          providerResult[window] = null;
          continue;
        }
        if (!Number.isSafeInteger(value) || value <= 0) {
          throw invalid(`${path}.${window} must be a positive safe integer or null`);
        }
        providerResult[window] = value;
      }
      if (windows.includes('short') && windows.includes('long')
          && providerResult.short !== null && providerResult.long !== null
          && providerResult.long < providerResult.short) {
        throw invalid(`${path}.long must be greater than or equal to short`);
      }
      planResult[provider] = Object.freeze(providerResult);
    }
    result[plan] = Object.freeze(planResult);
  }
  return Object.freeze(result);
}
