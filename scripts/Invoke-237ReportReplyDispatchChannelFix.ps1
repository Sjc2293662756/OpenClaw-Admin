#requires -Version 5.1

[CmdletBinding()]
param(
  [ValidateSet('Stage', 'Release')]
  [string]$Mode = 'Stage',
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
  [string]$ReleaseId
)

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-report-reply-dispatch-channel-fix.cjs'
if (-not (Test-Path -LiteralPath $credentialPath) -or -not (Test-Path -LiteralPath $runnerPath)) {
  throw 'The controlled report dispatch repair prerequisites are unavailable.'
}
$stored = Import-Clixml -LiteralPath $credentialPath
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
  $start.EnvironmentVariables['GAIOP_REPORT_DISPATCH_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_REPORT_DISPATCH_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_REPORT_DISPATCH_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $start.EnvironmentVariables['GAIOP_REPORT_DISPATCH_MODE'] = $Mode.ToLowerInvariant()
  $start.EnvironmentVariables['GAIOP_REPORT_DISPATCH_RELEASE_ID'] = $ReleaseId
  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  if ($process.ExitCode -ne 0 -or -not $result.completed) {
    $phase = if ($result.phase) { ' (' + [string]$result.phase + ')' } else { '' }
    throw ('The controlled report dispatch repair failed: ' + [string]$result.status + $phase)
  }
  $result | ConvertTo-Json -Depth 6
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout -ErrorAction SilentlyContinue
}
