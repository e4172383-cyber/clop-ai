import test from 'node:test';
import assert from 'node:assert/strict';
import * as remote from '../src/remote.js';

test('Remote requires an online desktop and explicit desktop decision', () => {
  const userId = `user-${Date.now()}`;
  const deviceId = 'desktop-a';
  assert.throws(() => remote.requestAccess(userId, deviceId), /не подключён/i);
  const beat = remote.heartbeat({ userId, deviceId, name: 'Test PC', version: '2.4.0', enabled: true });
  assert.equal(beat.session, null);
  const requested = remote.requestAccess(userId, deviceId);
  assert.ok(requested.request.id);
  const polled = remote.heartbeat({ userId, deviceId, name: 'Test PC', version: '2.4.0', enabled: true });
  assert.equal(polled.request.id, requested.request.id);
  const accepted = remote.decideAccess(userId, deviceId, requested.request.id, true);
  assert.ok(accepted.session.id);
});

test('Remote isolates accounts, validates commands and stores one screen snapshot', () => {
  const userId = `owner-${Date.now()}`;
  const deviceId = 'desktop-b';
  remote.heartbeat({ userId, deviceId, name: 'Owner PC', version: '2.4.0', enabled: true });
  const request = remote.requestAccess(userId, deviceId);
  const session = remote.decideAccess(userId, deviceId, request.request.id, true).session;
  assert.throws(() => remote.queueCommand('another-user', deviceId, session.id, 'screenshot', {}), /не активен/i);
  assert.throws(() => remote.queueCommand(userId, deviceId, session.id, 'click', { x: -1, y: 4 }), /координат/i);
  assert.throws(() => remote.queueCommand(userId, deviceId, session.id, 'key', { key: 'F12' }), /клавиша/i);
  const command = remote.queueCommand(userId, deviceId, session.id, 'screenshot', {});
  const beat = remote.heartbeat({ userId, deviceId, name: 'Owner PC', version: '2.4.0', enabled: true });
  assert.equal(beat.commands[0].id, command.id);
  const screen = `data:image/png;base64,${Buffer.from('screen').toString('base64')}`;
  remote.finishCommand(userId, deviceId, session.id, { id: command.id, ok: true, screen });
  const status = remote.remoteStatus(userId, deviceId);
  assert.equal(status.latestScreen.data, screen);
  assert.equal(status.results[0].hasScreen, true);
});

test('Remote stop immediately invalidates the session', () => {
  const userId = `stop-${Date.now()}`;
  const deviceId = 'desktop-c';
  remote.heartbeat({ userId, deviceId, name: 'Stop PC', version: '2.4.0', enabled: true });
  const request = remote.requestAccess(userId, deviceId);
  const session = remote.decideAccess(userId, deviceId, request.request.id, true).session;
  assert.equal(remote.endSession(userId, deviceId, session.id), true);
  assert.throws(() => remote.queueCommand(userId, deviceId, session.id, 'type', { text: 'hello' }), /не активен/i);
});
