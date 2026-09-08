'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WINDOWS_UPDATE_SCRIPT = String.raw`$ErrorActionPreference = 'SilentlyContinue'
function Write-UpdateLog([string]$message) {
  Add-Content -LiteralPath $env:CLOP_UPDATE_LOG -Value ("$(Get-Date -Format o) $message") -Encoding UTF8 -ErrorAction SilentlyContinue
}
$parentId = [int]$env:CLOP_PARENT_PID
Write-UpdateLog "waiting for parent $parentId"
Wait-Process -Id $parentId -ErrorAction SilentlyContinue
Write-UpdateLog 'parent exited'
$installRoot = [IO.Path]::GetFullPath($env:CLOP_INSTALL_DIR).TrimEnd('\')
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  $targets = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and (
      $_.Name -ieq 'Clop Code.exe' -or
      ($_.Name -ieq 'node.exe' -and ([string]$_.CommandLine).IndexOf($installRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    )
  })
  if ($targets.Count -eq 0) { break }
  $targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
}
Start-Sleep -Milliseconds 1200
Write-UpdateLog 'starting installer'
$installer = Start-Process -FilePath $env:CLOP_INSTALLER -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
Write-UpdateLog "installer exit $($installer.ExitCode)"
if ($installer.ExitCode -eq 0 -and (Test-Path -LiteralPath $env:CLOP_APP_PATH)) {
  Write-UpdateLog 'relaunching Clop Code'
  Start-Process -FilePath $env:CLOP_APP_PATH
}
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`;

function launchWindowsUpdate(options = {}) {
  const installerPath = path.resolve(String(options.installerPath || ''));
  const installDir = path.resolve(String(options.installDir || ''));
  const appPath = path.resolve(String(options.appPath || ''));
  const tempDir = path.resolve(String(options.tempDir || ''));
  const logPath = path.resolve(String(options.logPath || path.join(tempDir, 'clop-update.log')));
  const parentPid = Number(options.parentPid);
  if (!installerPath || !installDir || !appPath || !tempDir || !Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error('Не удалось подготовить безопасную установку обновления.');
  }
  const helperPath = path.join(tempDir, `clop-update-${parentPid}-${Date.now()}.ps1`);
  fs.writeFileSync(helperPath, WINDOWS_UPDATE_SCRIPT, { encoding: 'utf8', mode: 0o600 });
  const spawnImpl = options.spawnImpl || spawn;
  const child = spawnImpl('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helperPath,
  ], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      PATH: process.env.PATH,
      CLOP_PARENT_PID: String(parentPid),
      CLOP_INSTALLER: installerPath,
      CLOP_INSTALL_DIR: installDir,
      CLOP_APP_PATH: appPath,
      CLOP_UPDATE_LOG: logPath,
    },
  });
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    try { fs.unlinkSync(helperPath); } catch {}
    throw new Error('Не удалось запустить установку обновления.');
  }
  child.unref();
  return { pid: child.pid, helperPath };
}

module.exports = { WINDOWS_UPDATE_SCRIPT, launchWindowsUpdate };
