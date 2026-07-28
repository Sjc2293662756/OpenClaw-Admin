#requires -Version 5.1

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-dashboard-usage-probe.cjs'

if (-not (Test-Path -LiteralPath $credentialPath)) {
  throw 'The local controlled 237 connection record is unavailable.'
}
if (-not (Test-Path -LiteralPath $runnerPath)) {
  throw 'The controlled dashboard usage probe is unavailable.'
}

$stored = Import-Clixml -LiteralPath $credentialPath
if (-not $stored.Host -or -not $stored.Username -or $stored.Password -isnot [System.Security.SecureString]) {
  throw 'The local controlled 237 connection record is invalid.'
}

$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($stored.Password)
try {
  $node = Get-Command node.exe -ErrorAction Stop
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $node.Source
  $start.Arguments = ('"{0}"' -f $runnerPath)
  $start.WorkingDirectory = Split-Path -Parent $runnerPath
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables['GAIOP_DASHBOARD_PROBE_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_DASHBOARD_PROBE_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_DASHBOARD_PROBE_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  if ($process.ExitCode -ne 0 -or -not $result.completed) {
    throw ('The controlled dashboard usage probe did not complete: ' + [string]$result.status)
  }
  $result | ConvertTo-Json -Depth 4
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored -ErrorAction SilentlyContinue
  Remove-Variable stdout -ErrorAction SilentlyContinue
}
