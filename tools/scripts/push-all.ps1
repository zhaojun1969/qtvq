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
            Write-Host "  1. 确认私有仓存在：https://gitee.com/zhaobing2020_admin/qtvq" -ForegroundColor Yellow
            Write-Host "  2. 改回 SSH（不要用账号密码，Gitee 已限制密码认证）：" -ForegroundColor Yellow
            Write-Host "     git remote set-url gitee git@gitee.com:zhaobing2020_admin/qtvq.git" -ForegroundColor Yellow
            Write-Host "  3. 验证公钥已登记：ssh -T git@gitee.com" -ForegroundColor Yellow
            Write-Host "  4. 重跑：npm run git:push-all" -ForegroundColor Yellow
            Write-Host "  详见 docs/GITEE-SETUP.md" -ForegroundColor Yellow
        }
        exit 1
    }
}

Write-Host ""
Write-Host "Done. Verify both repos are PRIVATE in web settings." -ForegroundColor Green
