param(
  [Parameter(Mandatory=$true)][ValidateSet('up','down')][string]$Action,
  [Parameter(Mandatory=$true)][string]$WireGuardPath,
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [Parameter(Mandatory=$true)][string]$TunnelName
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $WireGuardPath -PathType Leaf)) { throw 'WireGuard is not installed.' }
if ($Action -eq 'up') {
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'VPN configuration was not created.' }
  $arguments = @('/installtunnelservice', $ConfigPath)
} else {
  $arguments = @('/uninstalltunnelservice', $TunnelName)
}
$process = Start-Process -FilePath $WireGuardPath -ArgumentList $arguments -Verb RunAs -Wait -PassThru -WindowStyle Hidden
if ($process.ExitCode -ne 0) { throw "WireGuard returned code $($process.ExitCode)." }
