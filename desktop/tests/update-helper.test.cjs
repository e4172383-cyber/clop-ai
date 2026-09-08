'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WINDOWS_UPDATE_SCRIPT, launchWindowsUpdate } = require('../src/update-helper.cjs');

test('update helper waits for Clop to exit before closing its leftover local server and installing', () => {
  assert.ok(WINDOWS_UPDATE_SCRIPT.indexOf('Wait-Process') < WINDOWS_UPDATE_SCRIPT.indexOf('Get-CimInstance'));
  assert.ok(WINDOWS_UPDATE_SCRIPT.indexOf('Get-CimInstance') < WINDOWS_UPDATE_SCRIPT.indexOf('Start-Process -FilePath $env:CLOP_INSTALLER'));
  assert.match(WINDOWS_UPDATE_SCRIPT, /node\.exe/);
  assert.match(WINDOWS_UPDATE_SCRIPT, /CLOP_INSTALL_DIR/);
  assert.match(WINDOWS_UPDATE_SCRIPT, /attempt -lt 40/);
  assert.match(WINDOWS_UPDATE_SCRIPT, /ArgumentList '\/S'/);
});

test('update helper passes paths as environment values and starts a detached hidden process', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clop-update-test-'));
  let call;
  const result = launchWindowsUpdate({
    installerPath: 'C:\\Temp\\Clop Setup.exe',
    installDir: 'C:\\Apps\\Clop Code',
    appPath: 'C:\\Apps\\Clop Code\\Clop Code.exe',
    tempDir,
    parentPid: 1234,
    spawnImpl(command, args, options) {
      call = { command, args, options };
      return { pid: 5678, unref() {} };
    },
  });
  assert.equal(result.pid, 5678);
  assert.equal(call.command, 'powershell.exe');
  assert.equal(call.options.detached, true);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env.CLOP_PARENT_PID, '1234');
  assert.equal(call.options.env.CLOP_INSTALLER, path.resolve('C:\\Temp\\Clop Setup.exe'));
  assert.equal(call.options.env.CLOP_INSTALL_DIR, path.resolve('C:\\Apps\\Clop Code'));
  assert.equal(call.options.env.CLOP_UPDATE_LOG, path.join(tempDir, 'clop-update.log'));
  assert.ok(fs.existsSync(result.helperPath));
  fs.rmSync(tempDir, { recursive: true, force: true });
});
