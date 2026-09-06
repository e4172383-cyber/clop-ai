const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  defaults,
  cleanSettings,
  parseAction,
  needsActionRecovery,
  resolveTarget,
  decision,
  approvalDecision,
  sensitive,
} = require('../src/policy.cjs');

test('parseAction returns null when the reply has no action', () => {
  assert.equal(parseAction('Обычный ответ без инструмента.'), null);
});

test('parseAction parses one valid action inside surrounding text', () => {
  assert.deepEqual(
    parseAction('Сейчас прочитаю.\n<clop_action>{"tool":"read","path":"src/main.cjs"}</clop_action>'),
    { tool: 'read', path: 'src/main.cjs' },
  );
  assert.deepEqual(
    parseAction('<clop_action>{"tool":"write","path":"empty.txt","content":""}</clop_action>'),
    { tool: 'write', path: 'empty.txt', content: '' },
  );
});

test('parseAction rejects malformed, unknown, and invalid actions', () => {
  const invalid = [
    '<clop_action>{broken json}</clop_action>',
    '<clop_action>{"tool":"delete","path":"file.txt"}</clop_action>',
    '<clop_action>{"tool":"read","path":""}</clop_action>',
    '<clop_action>{"tool":"shell","command":""}</clop_action>',
    '<clop_action>{"tool":"click","x":-1,"y":2}</clop_action>',
    '<clop_action>{"tool":"key","key":"F12"}</clop_action>',
  ];
  for (const action of invalid) assert.throws(() => parseAction(action));
});

test('parseAction rejects multiple actions in one reply', () => {
  assert.throws(
    () => parseAction('<clop_action>{"tool":"list","path":"."}</clop_action>\n<clop_action>{"tool":"read","path":"a.txt"}</clop_action>'),
    /несколько действий/i,
  );
});

test('needsActionRecovery catches code returned instead of creating the requested file', () => {
  assert.equal(needsActionRecovery(
    'Создай интерактивный сайт с аквариумом',
    'Сохраните код как aquarium.html\n```html\n<!doctype html><title>Аквариум</title>\n```',
  ), true);
  assert.equal(needsActionRecovery('Объясни, как устроен HTML', '```html\n<div>пример</div>\n```'), false);
  assert.equal(needsActionRecovery('Создай план проекта', 'Готов подробный план без исходного кода.'), false);
});

test('resolveTarget keeps normal paths inside and detects traversal', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clop-policy-'));
  const workDir = path.join(base, 'workspace');
  fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
  try {
    const inside = resolveTarget(workDir, path.join('src', 'new-file.txt'));
    assert.equal(inside.outside, false);
    assert.equal(inside.abs, path.join(workDir, 'src', 'new-file.txt'));

    const escaped = resolveTarget(workDir, path.join('..', 'outside.txt'));
    assert.equal(escaped.outside, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveTarget detects a directory link that escapes the workspace', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clop-policy-link-'));
  const workDir = path.join(base, 'workspace');
  const outsideDir = path.join(base, 'outside');
  const link = path.join(workDir, 'linked');
  fs.mkdirSync(workDir);
  fs.mkdirSync(outsideDir);
  try {
    try {
      fs.symlinkSync(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`Ссылки недоступны в этом окружении: ${error.code || error.message}`);
      return;
    }
    assert.equal(resolveTarget(workDir, path.join('linked', 'secret.txt')).outside, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveTarget rejects missing workspaces and special paths', () => {
  assert.throws(() => resolveTarget('', 'file.txt'), /рабочую папку/i);
  assert.throws(() => resolveTarget(process.cwd(), '\\\\server\\share'), /сетевые/i);
  assert.throws(() => resolveTarget(process.cwd(), '//server/share'), /сетевые/i);
  assert.throws(() => resolveTarget(process.cwd(), '//./pipe/clop'), /сетевые/i);
  if (process.platform === 'win32') assert.throws(() => resolveTarget(process.cwd(), 'NUL.txt'), /устройств Windows/i);
  assert.throws(() => resolveTarget(process.cwd(), 'bad\0name'), /специальные/i);
});

test('sensitive recognizes protected locations without false substring matches', () => {
  const protectedPaths = [
    path.join('C:', 'Users', 'me', '.ssh', 'id_ed25519'),
    path.join('project', '.env.production'),
    path.join('profile', '.aws', 'credentials'),
    path.join('browser', 'Cookies'),
    path.join('Windows', 'System32', 'config', 'SAM'),
  ];
  for (const target of protectedPaths) assert.equal(sensitive(target), true, target);
  assert.equal(sensitive(path.join('project', 'environment.md')), false);
  assert.equal(sensitive(path.join('project', 'cookies-recipe.txt')), false);
});

test('decision applies chat, workspace, full-access, and approval rules', () => {
  assert.equal(decision('chat', 'read', { outside: false, abs: 'notes.txt' }), 'deny');
  assert.equal(decision('workspace', 'read', { outside: false, abs: 'notes.txt' }), 'allow');
  assert.equal(decision('workspace', 'write', { outside: false, abs: 'notes.txt' }), 'ask');
  assert.equal(decision('workspace', 'read', { outside: true, abs: '..\\notes.txt' }), 'deny');
  assert.equal(decision('full', 'read', { outside: true, abs: 'D:\\notes.txt' }), 'allow');
  assert.equal(decision('full', 'write', { outside: true, abs: 'D:\\notes.txt' }), 'allow');
  assert.equal(decision('full', 'shell'), 'ask');
  assert.equal(decision('full', 'screenshot'), 'ask');
  assert.equal(decision('full', 'read', { outside: false, abs: 'C:\\Users\\me\\.env' }), 'ask');
});

test('approvalDecision supports smart, allow-all, and always-ask modes without bypassing access scope', () => {
  const inside = { outside: false, abs: 'notes.txt' };
  const outside = { outside: true, abs: 'D:\\notes.txt' };
  assert.equal(approvalDecision('workspace', 'read', inside, 'smart'), 'allow');
  assert.equal(approvalDecision('workspace', 'write', inside, 'smart'), 'ask');
  assert.equal(approvalDecision('workspace', 'shell', inside, 'allow'), 'allow');
  assert.equal(approvalDecision('workspace', 'read', inside, 'ask'), 'ask');
  assert.equal(approvalDecision('chat', 'read', inside, 'allow'), 'deny');
  assert.equal(approvalDecision('workspace', 'read', outside, 'allow'), 'deny');
  assert.equal(approvalDecision('full', 'write', outside, 'allow', { targetExists: true }), 'allow');
  assert.equal(approvalDecision('full', 'external', inside, 'allow'), 'ask');
});

test('cleanSettings accepts safe values, clamps numbers, and preserves protected fields', () => {
  const previous = { ...defaults, agreementVersion: '2026-09-05', agreementAt: 1234 };
  const cleaned = cleanSettings({
    animations: false,
    enterSends: false,
    fast: true,
    approvalMode: 'ask',
    theme: 'system',
    maxSteps: 99.9,
    shellTimeout: 1,
    model: 'gpt-5-4-mini',
    effort: 'high',
    agreementVersion: 'forged',
    agreementAt: 0,
  }, previous);

  assert.equal(cleaned.animations, false);
  assert.equal(cleaned.enterSends, false);
  assert.equal(cleaned.fast, true);
  assert.equal(cleaned.approvalMode, 'ask');
  assert.equal(cleaned.theme, 'system');
  assert.equal(cleaned.maxSteps, 30);
  assert.equal(cleaned.shellTimeout, 5);
  assert.equal(cleaned.model, 'gpt-5-4-mini');
  assert.equal(cleaned.effort, 'high');
  assert.equal(cleaned.agreementVersion, previous.agreementVersion);
  assert.equal(cleaned.agreementAt, previous.agreementAt);
});

test('cleanSettings supports Extra High when the selected model offers it', () => {
  const cleaned = cleanSettings({ effort: 'xhigh' }, defaults);
  assert.equal(cleaned.effort, 'xhigh');
});

test('cleanSettings ignores invalid types and values', () => {
  const previous = { ...defaults, theme: 'light', model: 'gpt-5-5', effort: 'medium', maxSteps: 8 };
  const cleaned = cleanSettings({
    animations: 'false',
    theme: 'neon',
    model: '../unsafe model',
    effort: 'ultra',
    maxSteps: Number.NaN,
    shellTimeout: Infinity,
    workDir: 'C:\\should-not-change-here',
  }, previous);
  assert.deepEqual(cleaned, previous);
});
