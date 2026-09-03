#requires -Version 5.1
<#
.SYNOPSIS
Runs the fixed-purpose 237 OpenClaw session runtime preflight.

.DESCRIPTION
Uses the existing user-scoped encrypted 237 connection record. The preflight
returns only runtime booleans, a sanitized reason code, and response-structure
counts. It does not print credentials, raw command output, or session values.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-session-reconciliation-runtime-preflight.cjs'

if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
  throw 'The controlled 237 connection record is unavailable.'
}
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
  throw 'The controlled runtime preflight runner is unavailable.'
}
if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot 'node_modules\ssh2\package.json') -PathType Leaf)) {
  throw 'The existing Admin SSH dependency is unavailable.'
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
  $start.WorkingDirectory = $repositoryRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables['GAIOP_SESSION_RECONCILIATION_237_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_SESSION_RECONCILIATION_237_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_SESSION_RECONCILIATION_237_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  $result | ConvertTo-Json -Depth 20
  if ($process.ExitCode -ne 0 -or -not $result.completed) { exit 1 }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout, result -ErrorAction SilentlyContinue
}
