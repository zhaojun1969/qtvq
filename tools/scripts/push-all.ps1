# 一键推送 GitHub + Gitee（均需私有仓库）

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

Write-Host "=== QTVQ push all remotes ===" -ForegroundColor Cyan

$remotes = @("origin", "gitee")
foreach ($r in $remotes) {
    $url = (git remote get-url $r 2>$null)
    if (-not $url) {
        Write-Host "Skip $r : remote not configured" -ForegroundColor Yellow
        continue
    }
    Write-Host ">> git push $r main ..." -ForegroundColor Green
    git push $r main
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: $r" -ForegroundColor Red
        if ($r -eq "gitee") {
            Write-Host "  1. Create PRIVATE repo at https://gitee.com/projects/new (name: qtvq)" -ForegroundColor Yellow
            Write-Host "  2. git remote set-url gitee https://gitee.com/YOUR_USER/qtvq.git" -ForegroundColor Yellow
            Write-Host "  3. Re-run: npm run git:push-all" -ForegroundColor Yellow
        }
        exit 1
    }
}

Write-Host ""
Write-Host "Done. Verify both repos are PRIVATE in web settings." -ForegroundColor Green
