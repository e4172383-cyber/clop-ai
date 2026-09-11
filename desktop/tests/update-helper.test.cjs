'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WINDOWS_UPDATE_SCRIPT, launchWindowsUpdate, waitForUpdateHelperReady } = require('../src/update-helper.cjs');

test('update helper waits for Clop to exit before closing its leftover local server and installing', () => {
  assert.ok(WINDOWS_UPDATE_SCRIPT.indexOf('Wait-Process') < WINDOWS_UPDATE_SCRIPT.indexOf('Get-CimInstance'));
  assert.ok(WINDOWS_UPDATE_SCRIPT.indexOf('Get-CimInstance') < WINDOWS_UPDATE_SCRIPT.indexOf('Start-Process -FilePath $env:CLOP_INSTALLER'));
  assert.match(WINDOWS_UPDATE_SCRIPT, /node\.exe/);
  assert.match(WINDOWS_UPDATE_SCRIPT, /CLOP_INSTALL_DIR/);
  assert.match(WINDOWS_UPDATE_SCRIPT, /attempt -lt 40/);
  assert.match(WINDOWS_UPDATE_SCRIPT, /ArgumentList '\/S'/);
  assert.ok(WINDOWS_UPDATE_SCRIPT.indexOf('CLOP_UPDATE_READY') < WINDOWS_UPDATE_SCRIPT.indexOf('Wait-Process'));
  assert.match(WINDOWS_UPDATE_SCRIPT, /update verified/);
});

test('update helper passes paths as environment values through a hidden independent launcher', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clop-update-test-'));
  let call;
  const result = launchWindowsUpdate({
    installerPath: 'C:\\Temp\\Clop Setup.exe',
    installDir: 'C:\\Apps\\Clop Code',
    appPath: 'C:\\Apps\\Clop Code\\Clop Code.exe',
    tempDir,
    expectedVersion: '2.4.7',
    parentPid: 1234,
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    wscriptPath: 'C:\\Windows\\System32\\wscript.exe',
    spawnImpl(command, args, options) {
      call = { command, args, options };
      return { pid: 5678, unref() {} };
    },
  });
  assert.equal(result.pid, 5678);
  assert.equal(call.command, 'C:\\Windows\\System32\\wscript.exe');
  assert.equal(call.options.detached, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env.CLOP_PARENT_PID, '1234');
  assert.equal(call.options.env.CLOP_INSTALLER, path.resolve('C:\\Temp\\Clop Setup.exe'));
  assert.equal(call.options.env.CLOP_INSTALL_DIR, path.resolve('C:\\Apps\\Clop Code'));
  assert.equal(call.options.env.CLOP_UPDATE_LOG, path.join(tempDir, 'clop-update.log'));
  assert.equal(call.options.env.CLOP_EXPECTED_VERSION, '2.4.7');
  assert.equal(call.options.env.CLOP_UPDATE_READY, result.readyPath);
  assert.equal(call.options.env.CLOP_UPDATE_LAUNCHER, result.launcherPath);
  assert.equal(call.options.env.SystemRoot, process.env.SystemRoot);
  assert.ok(fs.existsSync(result.helperPath));
  assert.ok(fs.existsSync(result.launcherPath));
  assert.match(fs.readFileSync(result.launcherPath, 'utf8'), /WScript\.Shell/);
  assert.match(fs.readFileSync(result.launcherPath, 'utf8'), /powershell\.exe/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('update helper handshake is required before the app may exit', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clop-update-ready-'));
  const readyPath = path.join(tempDir, 'ready');
  fs.writeFileSync(readyPath, 'ready');
  assert.equal(await waitForUpdateHelperReady(readyPath, { timeoutMs: 200 }), true);
  await assert.rejects(
    waitForUpdateHelperReady(path.join(tempDir, 'missing'), { timeoutMs: 100, intervalMs: 20 }),
    /не запустилась/,
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});
