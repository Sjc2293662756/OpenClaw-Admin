#requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
  [string]$ReleaseId,
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$ArchivePath,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{64}$')]
  [string]$ArchiveSha256
)

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-report-runtime-contract-restore.cjs'

if (-not (Test-Path -LiteralPath $credentialPath)) {
  throw 'The local controlled 237 connection record is unavailable.'
}
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
  throw 'The controlled report runtime restoration runner is unavailable.'
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
  $start.EnvironmentVariables['GAIOP_REPORT_RUNTIME_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_REPORT_RUNTIME_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_REPORT_RUNTIME_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $start.EnvironmentVariables['GAIOP_REPORT_RUNTIME_RELEASE_ID'] = $ReleaseId
  $start.EnvironmentVariables['GAIOP_REPORT_RUNTIME_ARCHIVE'] = (Resolve-Path -LiteralPath $ArchivePath).Path
  $start.EnvironmentVariables['GAIOP_REPORT_RUNTIME_ARCHIVE_SHA256'] = $ArchiveSha256.ToLowerInvariant()

  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  if ($process.ExitCode -ne 0 -or -not $result.completed) {
    throw ('The controlled report runtime restoration did not complete: ' +
      [string]$result.status + ' at ' + [string]$result.failurePhase +
      '; rolledBack=' + [string]$result.rolledBack)
  }
  $result | ConvertTo-Json -Depth 6
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout -ErrorAction SilentlyContinue
}
