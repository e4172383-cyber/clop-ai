import test from 'node:test';
import assert from 'node:assert/strict';
import { enterSupportMode, isSupportModeActive, leaveTransientModes, SUPPORT_MODE_TTL_MS } from '../src/conversation-modes.js';

test('choosing a normal bot action leaves support mode', () => {
  const user = { supportMode: true, supportModeAt: 100, bugReportMode: true };
  assert.equal(leaveTransientModes(user), true);
  assert.equal(user.supportMode, false);
  assert.equal(user.supportModeAt, undefined);
  assert.equal(user.bugReportMode, false);
});

test('support mode is explicit and expires instead of capturing later model prompts', () => {
  const user = {};
  enterSupportMode(user, 1_000);
  assert.equal(isSupportModeActive(user, 1_000 + SUPPORT_MODE_TTL_MS), true);
  assert.equal(isSupportModeActive(user, 1_001 + SUPPORT_MODE_TTL_MS), false);
  assert.equal(user.supportMode, false);
});
