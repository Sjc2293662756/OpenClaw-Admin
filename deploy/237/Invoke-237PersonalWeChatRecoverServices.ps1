#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$runnerPath = Join-Path $repositoryRoot 'scripts\gateway237-personal-wechat-recover-services.cjs'
$stored = Import-Clixml -LiteralPath $credentialPath
if (-not $stored.Host -or -not $stored.Username -or $stored.Password -isnot [System.Security.SecureString]) { throw 'The controlled connection record is invalid.' }
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
  $start.EnvironmentVariables['GAIOP_WEIXIN_RECOVERY_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_WEIXIN_RECOVERY_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_WEIXIN_RECOVERY_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  if ($process.ExitCode -ne 0 -or -not $result.completed) { throw "Service recovery failed: $($result.status)" }
  $result | ConvertTo-Json -Depth 3
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout -ErrorAction SilentlyContinue
}
