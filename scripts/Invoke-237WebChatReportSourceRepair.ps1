#requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^agent:main:main:dm:webchat-[a-f0-9]{32}$')]
  [string]$SessionKey,
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ReportId,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9-]{36}$')]
  [string]$SourceMessageId,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
  [string]$ReleaseId
)

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-webchat-report-source-repair.cjs'
if (-not (Test-Path -LiteralPath $credentialPath) -or -not (Test-Path -LiteralPath $runnerPath)) {
  throw 'The controlled WebChat report source repair prerequisites are unavailable.'
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
  $start.EnvironmentVariables['GAIOP_REPORT_REPAIR_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_REPORT_REPAIR_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_REPORT_REPAIR_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $start.EnvironmentVariables['GAIOP_REPORT_REPAIR_SESSION_KEY'] = $SessionKey
  $start.EnvironmentVariables['GAIOP_REPORT_REPAIR_REPORT_ID'] = $ReportId
  $start.EnvironmentVariables['GAIOP_REPORT_REPAIR_SOURCE_MESSAGE_ID'] = $SourceMessageId
  $start.EnvironmentVariables['GAIOP_REPORT_REPAIR_RELEASE_ID'] = $ReleaseId
  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  if ($process.ExitCode -ne 0 -or -not $result.completed) {
    throw ('The controlled WebChat report source repair failed: ' + [string]$result.status)
  }
  $result | ConvertTo-Json -Depth 5
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout -ErrorAction SilentlyContinue
}
