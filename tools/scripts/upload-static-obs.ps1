# Upload dist/qtvq-static.tgz to OSS (qtvq/static/)
# Usage: npm run upload:static-obs

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

& (Join-Path $PSScriptRoot "package-static.ps1")

$tar = Join-Path $Root "dist/qtvq-static.tgz"
if (-not (Test-Path $tar)) { throw "Missing $tar" }

if (-not (Test-Path "obs.env")) {
    Write-Host "ERROR: obs.env required" -ForegroundColor Red
    exit 1
}

$pipCheck = python -m pip show esdk-obs-python 2>&1
if ($LASTEXITCODE -ne 0) {
    $null = python -m pip install esdk-obs-python -q 2>&1
}

python (Join-Path $Root "tools/scripts/upload-obs.py") $tar
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ">> Server apply (SSH):" -ForegroundColor Green
Write-Host "  bash tools/scripts/sync-static-from-oss.sh"
