#requires -Version 5.1

[CmdletBinding()]
param(
  [ValidateSet('inspect', 'repair')]
  [string]$Mode = 'inspect',
  [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
  [string]$ReleaseId
)

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-report-registry-reconcile.cjs'
if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) { throw 'The controlled 237 connection record is unavailable.' }
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) { throw 'The report registry reconcile runner is unavailable.' }
if (-not $ReleaseId) { throw 'ReleaseId is required.' }
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
  $start.EnvironmentVariables['GAIOP_REPORT_REGISTRY_RECONCILE_MODE'] = $Mode
  $start.EnvironmentVariables['GAIOP_REPORT_REGISTRY_RECONCILE_RELEASE_ID'] = $ReleaseId
  $start.EnvironmentVariables['GAIOP_REPORT_REGISTRY_RECONCILE_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_REPORT_REGISTRY_RECONCILE_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_REPORT_REGISTRY_RECONCILE_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  $result | ConvertTo-Json -Depth 20
  if ($process.ExitCode -ne 0 -or -not $result.completed) { throw "The controlled report registry reconcile failed: $($result.errorCode); phase=$($result.phase); diagnostic=$($result.failureDiagnostic)" }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout -ErrorAction SilentlyContinue
}
