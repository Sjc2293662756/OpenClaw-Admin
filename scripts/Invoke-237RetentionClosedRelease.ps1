#requires -Version 5.1

[CmdletBinding()]
param(
  [ValidateSet('preflight', 'verify-units', 'deploy-upgrade', 'deploy-admin', 'diagnose-admin', 'close-disabled-timers', 'verify-watermark')]
  [string]$Mode = 'preflight',
  [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
  [string]$ReleaseId,
  [string]$AdminArchivePath,
  [string]$UpgradeArchivePath
)

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-retention-closed-release.cjs'

if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
  throw 'The controlled 237 connection record is unavailable.'
}
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
  throw 'The controlled retention release runner is unavailable.'
}
if ($Mode -eq 'verify-units') {
  if (-not $ReleaseId) { throw 'ReleaseId is required for unit verification.' }
  if (-not (Test-Path -LiteralPath $AdminArchivePath -PathType Leaf)) { throw 'The Admin archive is unavailable.' }
  if (-not (Test-Path -LiteralPath $UpgradeArchivePath -PathType Leaf)) { throw 'The Upgrade archive is unavailable.' }
}
if ($Mode -eq 'deploy-upgrade') {
  if (-not $ReleaseId) { throw 'ReleaseId is required for Upgrade deployment.' }
  if (-not (Test-Path -LiteralPath $UpgradeArchivePath -PathType Leaf)) { throw 'The Upgrade archive is unavailable.' }
}
if ($Mode -eq 'deploy-admin') {
  if (-not $ReleaseId) { throw 'ReleaseId is required for Admin deployment.' }
  if (-not (Test-Path -LiteralPath $AdminArchivePath -PathType Leaf)) { throw 'The Admin archive is unavailable.' }
}
if ($Mode -eq 'diagnose-admin' -and -not $ReleaseId) {
  throw 'ReleaseId is required for Admin diagnosis.'
}

$stored = Import-Clixml -LiteralPath $credentialPath
if (-not $stored.Host -or -not $stored.Username -or $stored.Password -isnot [System.Security.SecureString]) {
  throw 'The controlled 237 connection record is invalid.'
}

$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($stored.Password)
try {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = (Get-Command node.exe -ErrorAction Stop).Source
  $start.Arguments = ('"{0}"' -f $runnerPath)
  $start.WorkingDirectory = Split-Path -Parent $runnerPath
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables['GAIOP_RETENTION_RELEASE_MODE'] = $Mode
  $start.EnvironmentVariables['GAIOP_RETENTION_RELEASE_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_RETENTION_RELEASE_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_RETENTION_RELEASE_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ($ReleaseId) { $start.EnvironmentVariables['GAIOP_RETENTION_RELEASE_ID'] = $ReleaseId }
  if ($AdminArchivePath) {
    $start.EnvironmentVariables['GAIOP_RETENTION_RELEASE_ADMIN_ARCHIVE'] = (Resolve-Path -LiteralPath $AdminArchivePath).Path
  }
  if ($UpgradeArchivePath) {
    $start.EnvironmentVariables['GAIOP_RETENTION_RELEASE_UPGRADE_ARCHIVE'] = (Resolve-Path -LiteralPath $UpgradeArchivePath).Path
  }

  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  if ($process.ExitCode -ne 0 -or -not $result.completed) {
    $errorCode = if ($result.errorCode) { [string]$result.errorCode } else { 'RETENTION_RELEASE_RUNNER_FAILED' }
    $failurePhase = if ($result.failedPhase) { [string]$result.failedPhase } else { 'unknown' }
    $rollbackState = if ($result.rollbackComplete) { 'complete' } else { 'not-confirmed' }
    $eventCounts = if ($result.eventCounts) {
      "events=$($result.eventCounts.before)/$($result.eventCounts.afterFirst)/$($result.eventCounts.afterSecond)"
    } else { 'events=not-applicable' }
    $statusErrors = if ($result.statusErrors) { "status=$($result.statusErrors)" } else { 'status=not-applicable' }
    $testFailure = if ($result.testFailure) { "test=$($result.testFailure -replace "`r?`n", ' | ')" } else { 'test=not-applicable' }
    throw "The controlled retention release runner failed: $errorCode; phase=$failurePhase; rollback=$rollbackState; $eventCounts; $statusErrors; $testFailure"
  }
  $result | ConvertTo-Json -Depth 10
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout -ErrorAction SilentlyContinue
}
