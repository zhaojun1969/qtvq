# 一键：部署 qtvq-api + 同步 qtvq.cn 静态
# 前置：cf.env 含 CLOUDFLARE_API_TOKEN；SSH 可连阿里云（或跳过静态）

param([switch]$SkipStatic)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

if (-not (& (Join-Path $PSScriptRoot "load-cf-env.ps1"))) {
    Write-Host "ERROR: 复制 cf.env.example -> cf.env 并填写 CLOUDFLARE_API_TOKEN" -ForegroundColor Red
    Write-Host "  见 docs/CLOUDFLARE-TOKEN.md"
    exit 1
}

if (-not $env:CLOUDFLARE_API_TOKEN) {
    Write-Host "ERROR: cf.env 缺少 CLOUDFLARE_API_TOKEN" -ForegroundColor Red
    exit 1
}

if (-not $env:CLOUDFLARE_ACCOUNT_ID) {
    $env:CLOUDFLARE_ACCOUNT_ID = "bb7eb342a5cfde7c0a84cd9bd519a859"
}

& (Join-Path $PSScriptRoot "write-version.ps1")

Write-Host "=== 1/2 Deploy API (qtvq-api) ===" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "deploy.ps1") -SkipKv
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "=== API smoke test ===" -ForegroundColor Cyan
Start-Sleep -Seconds 3
try {
    $health = Invoke-WebRequest "https://qtvq-api.pages.dev/api/health" -UseBasicParsing -TimeoutSec 20
    Write-Host "[health] $($health.StatusCode) OK" -ForegroundColor Green
} catch {
    Write-Host "[health] FAIL - 部署可能仍在传播，稍后再试 check:live" -ForegroundColor Yellow
}

if (-not $SkipStatic) {
    Write-Host ""
    Write-Host "=== 2/2 Publish static (qtvq.cn + static.qtvq.cn) ===" -ForegroundColor Cyan
    # 2026-10-26 起静态站有**两份部署**：源站 nginx（HTML/CSS/JS）与
    # Cloudflare Pages 的 qtvq-site（收款码图片，用来卸载源站 5 Mbps 带宽）。
    # 只发一处 = 用户拿不到新收款码。publish-static.ps1 一条命令发两处，并在末尾
    # 跑 check-static-domain-sync 比对两端图片的 SHA-256 —— 不一致就失败退出。
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "publish-static.ps1") -SkipBuild
    if ($LASTEXITCODE -ne 0) {
        Write-Host "静态发布失败（源站或 Pages 未同步）。不要只发一处，重跑：" -ForegroundColor Yellow
        Write-Host "  powershell -ExecutionPolicy Bypass -File tools/scripts/publish-static.ps1" -ForegroundColor Yellow
        exit 1
    }
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "  npm run check:live"
