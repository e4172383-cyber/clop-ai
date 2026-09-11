'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  commandForModel,
  inputForModel,
  modelByKey,
  ownModels,
  parseCliOutput,
  providerByKey,
  providerList,
} = require('../src/own-providers.cjs');

test('exposes five supported local CLI providers with distinct model keys', () => {
  assert.deepEqual(providerList().map((item) => item.key), ['antigravity', 'gpt', 'claude', 'kimi', 'qwen']);
  const keys = providerList().flatMap((provider) => ownModels(provider).map((model) => model.key));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes('own-claude-sonnet'));
  assert.ok(keys.includes('own-kimi-k2.8'));
  assert.ok(keys.includes('own-antigravity-gemini-3.8'));
  assert.ok(keys.includes('own-antigravity-gemini-3.7'));
  assert.ok(keys.includes('own-antigravity-gemini-3.6'));
  assert.ok(keys.includes('own-antigravity-gemini-3.1-pro'));
});

test('Antigravity uses its documented stream-json stdin protocol and exact model slug', () => {
  const selection = modelByKey('own-antigravity-gemini-3.8');
  const args = commandForModel(selection, 'medium');
  assert.ok(args.includes('gemini-3.8-flash-medium'));
  assert.ok(args.includes('--sandbox'));
  assert.equal(args.includes('-p'), false);
  assert.deepEqual(JSON.parse(inputForModel(selection, 'Привет').trim()), {
    event: 'user', message: { content: 'Привет' },
  });
});

test('builds read-only or plan-mode local commands without putting prompt in arguments', () => {
  const prompt = 'текст & whoami';
  const gpt = commandForModel(modelByKey('own-gpt-auto'), 'medium');
  const claude = commandForModel(modelByKey('own-claude-sonnet'), 'high');
  assert.ok(gpt.includes('read-only'));
  assert.ok(claude.includes('plan'));
  assert.equal(gpt.some((part) => part.includes(prompt)), false);
  assert.equal(claude.some((part) => part.includes(prompt)), false);
});

test('parses JSON, JSONL, and plain local CLI replies', () => {
  assert.equal(parseCliOutput(JSON.stringify({ result: 'Готово' })), 'Готово');
  assert.equal(parseCliOutput('{"type":"start"}\n{"item":{"type":"agent_message","text":"Ответ"}}'), 'Ответ');
  assert.equal(parseCliOutput('Обычный ответ'), 'Обычный ответ');
});

test('rejects unknown provider and model keys', () => {
  assert.equal(providerByKey('unknown'), null);
  assert.equal(modelByKey('own-unknown-auto'), null);
});
