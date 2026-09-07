import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const plans = ['free', 'go', 'pro', 'max', 'max20', 'coderplus'];
const providers = ['claude', 'gpt', 'kimi', 'clop'];
process.env.TOKEN_LIMITS_JSON = JSON.stringify(Object.fromEntries(plans.map((plan) => [
  plan,
  Object.fromEntries(providers.map((provider) => [provider, { short: 100, long: 100 }])),
])));
const { isReady, refreshSessionInfo } = await import('../src/kimiauth.js');

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

test('expired Kimi OAuth session refreshes and is saved before a provider request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clop-kimi-refresh-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'credentials'));
    fs.writeFileSync(path.join(dir, 'config.toml'), 'base_url = "https://api.kimi.ai/coding/v1"\n');
    fs.writeFileSync(path.join(dir, 'region'), 'global');
    const credential = path.join(dir, 'credentials', 'kimi-code.json');
    fs.writeFileSync(credential, JSON.stringify({
      access_token: 'a'.repeat(40),
      refresh_token: 'r'.repeat(40),
      expires_at: 1,
    }));
    let called = 0;
    const session = await refreshSessionInfo({
      dir,
      oauthHost: 'https://auth.example.test',
      fetchImpl: async (url, options) => {
        called += 1;
        assert.equal(url, 'https://auth.example.test/api/oauth/token');
        assert.match(String(options.body), /grant_type=refresh_token/);
        return new Response(JSON.stringify({ access_token: 'n'.repeat(40), expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.equal(called, 1);
    assert.equal(session.accessToken, 'n'.repeat(40));
    const saved = JSON.parse(fs.readFileSync(credential, 'utf8'));
    assert.equal(saved.access_token, 'n'.repeat(40));
    assert.equal(saved.refresh_token, 'r'.repeat(40));
    assert.ok(saved.expires_at * 1000 > Date.now());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
