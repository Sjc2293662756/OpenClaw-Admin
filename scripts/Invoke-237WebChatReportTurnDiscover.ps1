#requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateLength(1, 300)]
  [string]$Prompt,
  [Parameter(Mandatory = $true)]
  [datetimeoffset]$From,
  [Parameter(Mandatory = $true)]
  [datetimeoffset]$To
)

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-webchat-report-turn-discover.cjs'
if (-not (Test-Path -LiteralPath $credentialPath) -or -not (Test-Path -LiteralPath $runnerPath)) {
  throw 'The controlled WebChat report discovery prerequisites are unavailable.'
}

$stored = Import-Clixml -LiteralPath $credentialPath
if (-not $stored.Host -or -not $stored.Username -or $stored.Password -isnot [System.Security.SecureString]) {
  throw 'The local controlled 237 connection record is invalid.'
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
  $start.EnvironmentVariables['GAIOP_REPORT_DISCOVERY_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_REPORT_DISCOVERY_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_REPORT_DISCOVERY_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $start.EnvironmentVariables['GAIOP_REPORT_DISCOVERY_PROMPT'] = $Prompt
  $start.EnvironmentVariables['GAIOP_REPORT_DISCOVERY_FROM'] = $From.ToUniversalTime().ToString('o')
  $start.EnvironmentVariables['GAIOP_REPORT_DISCOVERY_TO'] = $To.ToUniversalTime().ToString('o')

  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  if ($process.ExitCode -ne 0 -or -not $result.ok) {
    throw ('The controlled WebChat report discovery failed: ' + [string]$result.errorCode)
  }
  $result | ConvertTo-Json -Depth 10
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout -ErrorAction SilentlyContinue
}
