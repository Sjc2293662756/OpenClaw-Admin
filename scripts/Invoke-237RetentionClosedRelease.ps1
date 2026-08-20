#requires -Version 5.1

[CmdletBinding()]
param(
  [ValidateSet('preflight', 'verify-units', 'deploy-upgrade', 'deploy-admin', 'diagnose-admin', 'close-disabled-timers', 'verify-watermark', 'inspect-watermark-filesystems', 'deploy-watermark-probes', 'verify-enable-watermark', 'observe-watermark', 'rollback-watermark', 'repair-enable-upgrade-retention', 'enable-sqlite-backups', 'enable-report-retention')]
  [string]$Mode = 'preflight',
  [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
  [string]$ReleaseId,
  [string]$AdminArchivePath,
  [string]$UpgradeArchivePath,
  [string]$WatermarkArchivePath,
  [string]$AdminSourceRootPath,
  [string]$UpgradeSourceRootPath
)

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-retention-closed-release.cjs'
$reportRunnerPath = Join-Path $PSScriptRoot 'gateway237-report-retention-enable.sh'

if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
  throw 'The controlled 237 connection record is unavailable.'
}
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
  throw 'The controlled retention release runner is unavailable.'
}
if (-not (Test-Path -LiteralPath $reportRunnerPath -PathType Leaf)) {
  throw 'The controlled report retention release runner is unavailable.'
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
if ($Mode -in @('deploy-watermark-probes', 'verify-enable-watermark', 'observe-watermark', 'rollback-watermark') -and -not $ReleaseId) {
  throw 'ReleaseId is required for the storage watermark filesystem release.'
}
if ($Mode -eq 'repair-enable-upgrade-retention' -and -not $ReleaseId) {
  throw 'ReleaseId is required for Upgrade retention repair and enablement.'
}
if ($Mode -eq 'enable-sqlite-backups' -and -not $ReleaseId) {
  throw 'ReleaseId is required for SQLite backup enablement.'
}
if ($Mode -eq 'enable-report-retention' -and -not $ReleaseId) {
  throw 'ReleaseId is required for report retention enablement.'
}
if ($Mode -eq 'enable-report-retention') {
  if (-not (Test-Path -LiteralPath $AdminSourceRootPath -PathType Container)) {
    throw 'The verified Admin report retention source root is unavailable.'
  }
  foreach ($relativePath in @(
    'package.json',
    'server\admin-retention-cleaner.js',
    'server\database.js',
    'server\report-retention-cleanup.js',
    'server\report-retention-service.js',
    'server\lib\report-retention-schema.js',
    'server\lib\report-storage-path.js',
    'deploy\systemd\gaiop-report-retention-cleanup.service',
    'deploy\systemd\gaiop-report-retention-cleanup.timer',
    'deploy\iso\env\report-retention.policy.example'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $AdminSourceRootPath $relativePath) -PathType Leaf)) {
      throw "The verified Admin report retention source is incomplete: $relativePath"
    }
  }
}
if ($Mode -eq 'enable-sqlite-backups') {
  if (-not (Test-Path -LiteralPath $AdminSourceRootPath -PathType Container)) {
    throw 'The verified Admin source root is unavailable.'
  }
  if (-not (Test-Path -LiteralPath $UpgradeSourceRootPath -PathType Container)) {
    throw 'The verified Upgrade source root is unavailable.'
  }
  foreach ($relativePath in @(
    'package.json',
    'server\sqlite-backup.js',
    'server\sqlite-restore-test.js',
    'server\lib\sqlite-backup-service.js',
    'deploy\systemd\gaiop-admin-sqlite-backup.service',
    'deploy\systemd\gaiop-admin-sqlite-backup.timer'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $AdminSourceRootPath $relativePath) -PathType Leaf)) {
      throw "The verified Admin SQLite backup source is incomplete: $relativePath"
    }
  }
  foreach ($relativePath in @(
    'package.json',
    'src\sqlite-backup.js',
    'src\sqlite-restore-test.js',
    'src\services\SqliteBackupService.js',
    'src\config.js',
    'deploy\systemd\gaiop-upgrade-sqlite-backup.service',
    'deploy\systemd\gaiop-upgrade-sqlite-backup.timer'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $UpgradeSourceRootPath $relativePath) -PathType Leaf)) {
      throw "The verified Upgrade SQLite backup source is incomplete: $relativePath"
    }
  }
}
if ($Mode -eq 'repair-enable-upgrade-retention') {
  if (-not (Test-Path -LiteralPath $UpgradeSourceRootPath -PathType Container)) {
    throw 'The verified Upgrade source root is unavailable.'
  }
  foreach ($relativePath in @(
    'src\retention-cleanup.js',
    'src\services\RetentionRunner.js',
    'src\services\PackageCleaner.js',
    'src\services\BackupCleaner.js',
    'src\services\RetentionQualification.js',
    'src\database\connection.js',
    'src\config.js',
    'deploy\systemd\gaiop-upgrade-retention-cleanup.service',
    'deploy\systemd\gaiop-upgrade-retention-cleanup.timer'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $UpgradeSourceRootPath $relativePath) -PathType Leaf)) {
      throw "The verified Upgrade retention source is incomplete: $relativePath"
    }
  }
}
if ($Mode -eq 'deploy-watermark-probes' -and -not (Test-Path -LiteralPath $WatermarkArchivePath -PathType Leaf)) {
  throw 'The storage watermark probe archive is unavailable.'
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
  if ($WatermarkArchivePath) {
    $start.EnvironmentVariables['GAIOP_RETENTION_RELEASE_WATERMARK_ARCHIVE'] = (Resolve-Path -LiteralPath $WatermarkArchivePath).Path
  }
  if ($AdminSourceRootPath) {
    $start.EnvironmentVariables['GAIOP_RETENTION_RELEASE_ADMIN_SOURCE_ROOT'] = (Resolve-Path -LiteralPath $AdminSourceRootPath).Path
  }
  if ($UpgradeSourceRootPath) {
    $start.EnvironmentVariables['GAIOP_RETENTION_RELEASE_UPGRADE_SOURCE_ROOT'] = (Resolve-Path -LiteralPath $UpgradeSourceRootPath).Path
  }

  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  if ($process.ExitCode -ne 0 -or -not $result.completed) {
    if ($Mode -eq 'enable-report-retention') {
      $result | ConvertTo-Json -Depth 12
    }
    if ($result.errorCode -in @('REPORT_RETENTION_PERMANENT_DELETE_CONFIRMATION_REQUIRED', 'REPORT_RETENTION_ANOMALY_GATE_FAILED')) {
      exit 2
    }
    $errorCode = if ($result.errorCode) { [string]$result.errorCode } else { 'RETENTION_RELEASE_RUNNER_FAILED' }
    $failurePhase = if ($result.failedPhase) { [string]$result.failedPhase } else { 'unknown' }
    $rollbackState = if ($result.rollbackComplete) { 'complete' } else { 'not-confirmed' }
    $eventCounts = if ($result.eventCounts) {
      "events=$($result.eventCounts.before)/$($result.eventCounts.afterFirst)/$($result.eventCounts.afterSecond)"
    } else { 'events=not-applicable' }
    $statusErrors = if ($result.statusErrors) { "status=$($result.statusErrors)" } else { 'status=not-applicable' }
    $testFailure = if ($result.testFailure) {
      "test=$($result.testFailure -replace "`r?`n", ' | ')"
    } elseif ($result.diagnostic) {
      "diagnostic=$($result.diagnostic -replace "`r?`n", ' | ')"
    } else { 'test=not-applicable' }
    $unitDiagnostics = if ($result.diagnostics) {
      "unit_workdir=$($result.diagnostics.workingDirectory); dropins=$($result.diagnostics.dropInPaths); exec=$($result.diagnostics.execStart); env_files=$($result.diagnostics.environmentFiles); rw_paths=$($result.diagnostics.readWritePaths)"
    } else { 'unit_diagnostics=not-applicable' }
    throw "The controlled retention release runner failed: $errorCode; phase=$failurePhase; rollback=$rollbackState; $eventCounts; $statusErrors; $testFailure; $unitDiagnostics"
  }
  $result | ConvertTo-Json -Depth 10
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout -ErrorAction SilentlyContinue
}
