# Build context zip and upload to OBS
# Prereq: copy obs.env.example -> obs.env, pip install esdk-obs-python

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

if (-not (Test-Path "obs.env")) {
    Write-Host "ERROR: Create obs.env from obs.env.example (AK/SK/endpoint/bucket)" -ForegroundColor Red
    Write-Host "  copy obs.env.example obs.env" -ForegroundColor Yellow
    exit 1
}

Write-Host ">> Build context bundle ..."
& powershell -ExecutionPolicy Bypass -File (Join-Path $Root "tools\scripts\build-context-bundle.ps1")
$zip = Get-ChildItem "dist\qtvq-context-*.zip" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $zip) { throw "No zip produced" }

Write-Host ">> Upload $($zip.Name) ..."
python -m pip install esdk-obs-python -q 2>$null
python (Join-Path $Root "tools\scripts\upload-obs.py") $zip.FullName
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Done. Object in bucket prefix from obs.env (OBS_PREFIX)" -ForegroundColor Green
