#requires -Version 5.1

$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'GAIOP') 'alert-syslog-connection.clixml'
$runnerPath = Join-Path $PSScriptRoot 'gateway237-report-runtime-path-inspect.cjs'
if (-not (Test-Path -LiteralPath $credentialPath) -or -not (Test-Path -LiteralPath $runnerPath)) { throw 'Inspection prerequisites unavailable.' }
$stored = Import-Clixml -LiteralPath $credentialPath
if (-not $stored.Host -or -not $stored.Username -or $stored.Password -isnot [System.Security.SecureString]) { throw 'Invalid controlled connection record.' }
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
  $start.EnvironmentVariables['GAIOP_REPORT_PATH_SSH_HOST'] = [string]$stored.Host
  $start.EnvironmentVariables['GAIOP_REPORT_PATH_SSH_USERNAME'] = [string]$stored.Username
  $start.EnvironmentVariables['GAIOP_REPORT_PATH_SSH_PASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd()
  $null = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $result = $stdout | ConvertFrom-Json -ErrorAction Stop
  if ($process.ExitCode -ne 0 -or -not $result.ok) { throw ('Runtime path inspection failed: ' + [string]$result.errorCode) }
  $result | ConvertTo-Json -Depth 10
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable stored, stdout -ErrorAction SilentlyContinue
}
