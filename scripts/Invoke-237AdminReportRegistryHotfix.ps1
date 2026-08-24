#requires -Version 5.1

[CmdletBinding()]
param(
  [ValidateSet('preflight', 'deploy')]
  [string]$Mode = 'preflight',
  [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
  [string]$ReleaseId,
  [string]$SourceRootPath
)

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-admin-report-registry-hotfix.cjs'
if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) { throw 'The controlled 237 connection record is unavailable.' }
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) { throw 'The Admin report registry hotfix runner is unavailable.' }
if ($Mode -eq 'deploy') {
  if (-not $ReleaseId) { throw 'ReleaseId is required for deployment.' }
  if (-not (Test-Path -LiteralPath $SourceRootPath -PathType Container)) { throw 'The Admin source root is unavailable.' }
  foreach ($relativePath in @('server\index.js', 'server\routes\reports.js', 'server\report-registry-sync.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceRootPath $relativePath) -PathType Leaf)) { throw "The Admin hotfix source is incomplete: $relativePath" }
  }
}
$stored = Import-Clixml -LiteralPath $credentialPath
if (-not $stored.Host -or -not $stored.Username -or $stored.Password -isnot [System.Security.SecureString]) { throw 'The controlled 237 connection record is invalid.' }
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
  $start.EnvironmentVariables['GAIOP_ADMIN_REPORT_REGISTRY_HOTFIX_MODE'] = $Mode
  $start.EnvironmentVariables['GAIOP_ADMIN_REPORT_REGISTRY_HOTFIX_RELEASE_ID'] = $ReleaseId
  $start.EnvironmentVariables['GAIOP_ADMIN_REPORT_REGISTRY_HOTFIX_SOURCE_ROOT'] = if ($SourceRootPath) { (Resolve-Path -LiteralPath $SourceRootPath).Path } else { '' }
  $start.EnvironmentVariables['GAIOP_ADMIN_REPORT_REGISTRY_HOTFIX_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_ADMIN_REPORT_REGISTRY_HOTFIX_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_ADMIN_REPORT_REGISTRY_HOTFIX_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  $result | ConvertTo-Json -Depth 10
  if ($Mode -eq 'preflight') { if ($process.ExitCode -ne 0 -or -not $result.completed) { exit 1 }; return }
  if ($process.ExitCode -ne 0 -or -not $result.completed) { throw "The controlled Admin report registry hotfix failed: $($result.errorCode); phase=$($result.phase); diagnostic=$($result.failureDiagnostic)" }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout -ErrorAction SilentlyContinue
}
