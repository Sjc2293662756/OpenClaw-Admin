#requires -Version 5.1
<##
.SYNOPSIS
Runs the fixed-purpose 237 SQLite backup and isolated recovery verification.

.DESCRIPTION
This runner has no deployment, cleanup, or production-restore mode. It emits
only timer, filesystem, integrity, and schema metadata; temporary SQLite copies
are created and removed under the pre-approved restore-test directories.
##>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-sqlite-backup-recovery-verify.cjs'
if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) { throw 'The controlled 237 connection record is unavailable.' }
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) { throw 'The controlled SQLite backup verifier is unavailable.' }

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
  $start.EnvironmentVariables['GAIOP_SQLITE_VERIFY_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_SQLITE_VERIFY_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_SQLITE_VERIFY_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  if ($process.ExitCode -ne 0 -or -not $result.completed) {
    $code = if ($result.errorCode) { [string]$result.errorCode } else { 'SQLITE_VERIFY_FAILED' }
    $result | ConvertTo-Json -Depth 10
    throw "The controlled SQLite backup verification did not complete: $code. No production database was changed. Diagnostic=$($result | ConvertTo-Json -Compress -Depth 10)"
  }
  $result | ConvertTo-Json -Depth 10
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout -ErrorAction SilentlyContinue
}
