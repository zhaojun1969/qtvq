# Sync context + docs to Obsidian vault, then upload context zip to OSS
# Usage: npm run sync:obs  |  pnpm sync:obs

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

Write-Host "=== 1/3 Build context bundle ===" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "build-context-bundle.ps1")

Write-Host ""
Write-Host "=== 2/3 Sync docs -> Obsidian vault ===" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "sync-obsidian.ps1")

Write-Host ""
Write-Host "=== 3/3 Upload context zip -> OSS ===" -ForegroundColor Cyan
if (Test-Path (Join-Path $Root "obs.env")) {
    python (Join-Path $Root "tools/scripts/upload-obs.py")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
    Write-Host "Skip OSS upload: no obs.env (Obsidian sync done)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Obsidian vault: $Root\obsidian" -ForegroundColor Green
