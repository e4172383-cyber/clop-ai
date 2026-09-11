'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WINDOWS_UPDATE_SCRIPT = String.raw`$ErrorActionPreference = 'Continue'
function Write-UpdateLog([string]$message) {
  Add-Content -LiteralPath $env:CLOP_UPDATE_LOG -Value ("$(Get-Date -Format o) $message") -Encoding UTF8 -ErrorAction SilentlyContinue
}
Write-UpdateLog "helper started pid=$PID"
try { [IO.File]::WriteAllText($env:CLOP_UPDATE_READY, 'ready') } catch { Write-UpdateLog "ready marker failed: $($_.Exception.Message)" }
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
try {
  $installer = Start-Process -FilePath $env:CLOP_INSTALLER -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
  Write-UpdateLog "installer exit $($installer.ExitCode)"
} catch {
  $installer = $null
  Write-UpdateLog "installer failed: $($_.Exception.Message)"
}
$appExists = Test-Path -LiteralPath $env:CLOP_APP_PATH
$actualVersion = ''
if ($appExists) {
  try { $actualVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($env:CLOP_APP_PATH).FileVersion } catch {}
}
$versionOk = $appExists -and $actualVersion.StartsWith($env:CLOP_EXPECTED_VERSION, [StringComparison]::OrdinalIgnoreCase)
if ($installer -and $installer.ExitCode -eq 0 -and $versionOk) {
  Write-UpdateLog "update verified $actualVersion"
} else {
  Write-UpdateLog "update not verified expected=$($env:CLOP_EXPECTED_VERSION) actual=$actualVersion"
}
if ($appExists) {
  Write-UpdateLog 'relaunching Clop Code'
  Start-Process -FilePath $env:CLOP_APP_PATH -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $env:CLOP_UPDATE_READY -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $env:CLOP_UPDATE_LAUNCHER -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`;

function powershellPath(env = process.env) {
  const systemRoot = String(env.SystemRoot || env.WINDIR || 'C:\\Windows');
  const full = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

function wscriptPath(env = process.env) {
  const systemRoot = String(env.SystemRoot || env.WINDIR || 'C:\\Windows');
  const full = path.join(systemRoot, 'System32', 'wscript.exe');
  return fs.existsSync(full) ? full : 'wscript.exe';
}

function vbsString(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function launchWindowsUpdate(options = {}) {
  const installerPath = path.resolve(String(options.installerPath || ''));
  const installDir = path.resolve(String(options.installDir || ''));
  const appPath = path.resolve(String(options.appPath || ''));
  const tempDir = path.resolve(String(options.tempDir || ''));
  const logPath = path.resolve(String(options.logPath || path.join(tempDir, 'clop-update.log')));
  const expectedVersion = String(options.expectedVersion || '').trim();
  const parentPid = Number(options.parentPid);
  if (!installerPath || !installDir || !appPath || !tempDir || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(expectedVersion)
    || !Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error('Не удалось подготовить безопасную установку обновления.');
  }
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const updateId = `${parentPid}-${Date.now()}`;
  const helperPath = path.join(tempDir, `clop-update-${updateId}.ps1`);
  const launcherPath = path.join(tempDir, `clop-update-${updateId}.vbs`);
  const readyPath = path.join(tempDir, `clop-update-${updateId}.ready`);
  fs.writeFileSync(helperPath, WINDOWS_UPDATE_SCRIPT, { encoding: 'utf8', mode: 0o600 });
  const command = [
    `"${options.powershellPath || powershellPath()}"`,
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `"${helperPath}"`,
  ].join(' ');
  fs.writeFileSync(
    launcherPath,
    `CreateObject("WScript.Shell").Run ${vbsString(command)}, 0, False\r\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  const spawnImpl = options.spawnImpl || spawn;
  const child = spawnImpl(options.wscriptPath || wscriptPath(), [launcherPath], {
    // A detached PowerShell process silently skips its script on some Windows
    // builds. WScript starts PowerShell outside Electron's process lifetime.
    detached: false,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLOP_PARENT_PID: String(parentPid),
      CLOP_INSTALLER: installerPath,
      CLOP_INSTALL_DIR: installDir,
      CLOP_APP_PATH: appPath,
      CLOP_UPDATE_LOG: logPath,
      CLOP_UPDATE_READY: readyPath,
      CLOP_UPDATE_LAUNCHER: launcherPath,
      CLOP_EXPECTED_VERSION: expectedVersion,
    },
  });
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    try { fs.unlinkSync(helperPath); } catch {}
    try { fs.unlinkSync(launcherPath); } catch {}
    throw new Error('Не удалось запустить установку обновления.');
  }
  child.unref();
  return { pid: child.pid, helperPath, launcherPath, readyPath, logPath };
}

async function waitForUpdateHelperReady(readyPath, options = {}) {
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 7_000);
  const intervalMs = Math.max(20, Number(options.intervalMs) || 50);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(readyPath, 'utf8').trim() === 'ready') return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Служба установки обновления не запустилась. Приложение оставлено открытым.');
}

function cancelWindowsUpdate(update) {
  if (!update) return;
  try { process.kill(Number(update.pid)); } catch {}
  for (const file of [update.readyPath, update.launcherPath, update.helperPath]) {
    try { fs.unlinkSync(file); } catch {}
  }
}

module.exports = { WINDOWS_UPDATE_SCRIPT, powershellPath, wscriptPath, launchWindowsUpdate, waitForUpdateHelperReady, cancelWindowsUpdate };
