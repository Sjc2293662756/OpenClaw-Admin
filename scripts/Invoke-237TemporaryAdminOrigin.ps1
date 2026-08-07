#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Enable', 'Disable')]
  [string]$Mode,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
  [string]$ReleaseId
)

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-admin-temporary-origin.cjs'
if (-not (Test-Path -LiteralPath $credentialPath) -or -not (Test-Path -LiteralPath $runnerPath)) {
  throw 'The controlled temporary-origin prerequisites are unavailable.'
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
  $start.WorkingDirectory = $PSScriptRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables['GAIOP_ORIGIN_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_ORIGIN_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_ORIGIN_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $start.EnvironmentVariables['GAIOP_ORIGIN_MODE'] = $Mode.ToLowerInvariant()
  $start.EnvironmentVariables['GAIOP_ORIGIN_RELEASE_ID'] = $ReleaseId
  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  if ($process.ExitCode -ne 0 -or -not $result.completed) {
    throw 'The controlled temporary-origin operation failed and was rolled back.'
  }
  $result | ConvertTo-Json -Depth 3
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout, stderr -ErrorAction SilentlyContinue
}
