#requires -Version 5.1
<##
.SYNOPSIS
Runs the fixed-purpose, read-only 237 log and capacity inspection.

.DESCRIPTION
The runner accepts no target, command, or path parameters. It uses the
user-scoped encrypted connection record only in process memory and prints
only the runner's aggregated, path-free JSON result.
##>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-log-capacity-readonly-probe.cjs'

if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
  throw 'The controlled 237 connection record is unavailable.'
}
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
  throw 'The log-capacity read-only runner is unavailable.'
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
  $start.WorkingDirectory = $PSScriptRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables['GAIOP_LOG_CAPACITY_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_LOG_CAPACITY_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_LOG_CAPACITY_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  if ($process.ExitCode -ne 0 -or -not $result.completed) {
    $code = if ($result -and $result.errorCode) { [string]$result.errorCode } else { 'LOG_CAPACITY_PROBE_FAILED' }
    throw "The controlled log-capacity probe did not complete: $code. No remote changes were attempted."
  }
  $result | ConvertTo-Json -Depth 8
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout, result -ErrorAction SilentlyContinue
}
