import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const plans = ['free', 'go', 'pro', 'max', 'max20', 'coderplus'];
const providers = ['claude', 'gpt', 'kimi'];
process.env.TOKEN_LIMITS_JSON = JSON.stringify(Object.fromEntries(plans.map((plan) => [
  plan,
  Object.fromEntries(providers.map((provider) => [provider, { short: 100, long: 100 }])),
])));
const { isReady } = await import('../src/kimiauth.js');

test('Kimi readiness requires config and usable OAuth credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clop-kimi-auth-test-'));
  try {
    assert.equal(isReady(dir), false);
    fs.writeFileSync(path.join(dir, 'config.toml'), '[models]\n');
    assert.equal(isReady(dir), false);
    fs.mkdirSync(path.join(dir, 'credentials'));
    fs.writeFileSync(path.join(dir, 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'short' }));
    assert.equal(isReady(dir), false);
    fs.writeFileSync(path.join(dir, 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'x'.repeat(40) }));
    assert.equal(isReady(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
