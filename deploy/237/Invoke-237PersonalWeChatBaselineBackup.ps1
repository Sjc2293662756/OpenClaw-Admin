#requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^personal-wechat-(?:before|after)-[0-9]{8}T[0-9]{6}Z$')]
  [string]$BackupId
)

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$runnerPath = Join-Path $repositoryRoot 'scripts\gateway237-personal-wechat-baseline-backup.cjs'
$dependencyRoot = Join-Path $repositoryRoot 'node_modules'

if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
  throw 'The local controlled 237 connection record is unavailable.'
}
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
  throw 'The controlled personal WeChat baseline backup runner is unavailable.'
}
if (-not (Test-Path -LiteralPath $dependencyRoot -PathType Container)) {
  throw 'The local controlled SSH dependency root is unavailable.'
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
  $start.WorkingDirectory = $repositoryRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables['NODE_PATH'] = $dependencyRoot
  $start.EnvironmentVariables['GAIOP_WEIXIN_BACKUP_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_WEIXIN_BACKUP_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_WEIXIN_BACKUP_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $start.EnvironmentVariables['GAIOP_WEIXIN_BACKUP_ID'] = $BackupId

  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  if ($process.ExitCode -ne 0 -or -not $result.completed) {
    throw "The controlled personal WeChat baseline backup failed: $($result.status); remoteExit=$($result.remoteExitCode)"
  }
  $result | ConvertTo-Json -Depth 4
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout -ErrorAction SilentlyContinue
}
