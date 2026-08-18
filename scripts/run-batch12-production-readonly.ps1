param(
  [string]$OutputPath = (Join-Path $env:TEMP 'gaiop-batch12-production-readonly.json')
)

$ErrorActionPreference = 'Stop'
$collector = Join-Path $PSScriptRoot 'batch12-production-readonly.py'
if (-not (Test-Path -LiteralPath $collector -PathType Leaf)) {
  throw "Collector script is missing: $collector"
}

$lines = Get-Content -LiteralPath $collector -Raw -Encoding UTF8 |
  & ssh -T `
    -o PreferredAuthentications=password `
    -o PubkeyAuthentication=no `
    netinside@101.254.114.237 `
    'python3 -'

if ($LASTEXITCODE -ne 0) {
  throw "Remote read-only qualification failed with exit code $LASTEXITCODE"
}

$jsonLine = $lines | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1
if (-not $jsonLine) {
  throw 'Remote command returned no JSON result'
}
$json = $jsonLine.Trim()
$null = $json | ConvertFrom-Json
$fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
[System.IO.File]::WriteAllText($fullOutputPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
Write-Host "Read-only qualification result: $fullOutputPath"
