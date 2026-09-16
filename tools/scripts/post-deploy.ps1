# Post-deploy: upload secrets from .dev.vars, redeploy qtvq-api, smoke test
# Usage: powershell -ExecutionPolicy Bypass -File tools/scripts/post-deploy.ps1

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

. (Join-Path $PSScriptRoot "load-cf-env.ps1") | Out-Null
if (-not $env:CLOUDFLARE_ACCOUNT_ID) {
    $env:CLOUDFLARE_ACCOUNT_ID = "bb7eb342a5cfde7c0a84cd9bd519a859"
}

$Project = "qtvq-api"
$ApiBase = "https://qtvq-api.pages.dev"

if (-not $env:CLOUDFLARE_API_TOKEN) {
    $whoami = & npx wrangler whoami 2>&1 | Out-String
    if ($whoami -match 'not authenticated') {
        Write-Host "ERROR: cf.env 缺少 CLOUDFLARE_API_TOKEN，或先 npx wrangler login" -ForegroundColor Red
        exit 1
    }
}

if (Test-Path ".dev.vars") {
    $lines = Get-Content ".dev.vars" -Encoding UTF8
    $line = $lines | Where-Object { $_ -match '^PAYMENT_ADMIN_KEY=' } | Select-Object -First 1
    if ($line -match '^PAYMENT_ADMIN_KEY=(.+)$') {
        $val = $Matches[1].Trim()
        Write-Host ">> Upload PAYMENT_ADMIN_KEY to Pages ($Project) ..."
        $val | & npx wrangler pages secret put PAYMENT_ADMIN_KEY --project-name=$Project
    }
    # ⚠️ 不要在这里自己解析 .dev.vars 推密钥。
    # 这里原来用 `$_ -match "^KEY=" | Select-Object -First 1` 取值，而
    # WECHAT_MCH_PRIVATE_KEY 是**多行 PEM**（BEGIN + 26 行 base64 + END），
    # 于是只把 27 字符的 "-----BEGIN PRIVATE KEY-----" 推了上去 ——
    # 2026-09-15 实际发生过：线上微信支付立刻变成 502 "Invalid merchant private key"。
    # 改为调用三个专用脚本，它们对该多行值有正确的收集逻辑与 normalize 校验。
    Write-Host ">> Upload secrets via dedicated scripts ..."
    foreach ($sub in @("upload-mail-secrets.ps1", "upload-speech-secrets.ps1", "upload-wechat-secrets.ps1")) {
        $subPath = Join-Path $PSScriptRoot $sub
        if (-not (Test-Path $subPath)) { continue }
        Write-Host "   >> $sub"
        & powershell -ExecutionPolicy Bypass -File $subPath
        if ($LASTEXITCODE -ne 0) {
            Write-Host ("      ($sub 退出码 $LASTEXITCODE，已跳过；不中断整体部署)") -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "Skip secrets: no .dev.vars (copy from .dev.vars.example)" -ForegroundColor Yellow
}

# 与 deploy.ps1 保持一致：绝不发布仓库根目录。
# 这里原本是 `wrangler pages deploy .`，而 wrangler.toml 里 pages_build_output_dir = "."，
# 等于把 cf.env / obs.env / .dev.vars / server/.env 全部公开（2026-09-13 事件）—— 别改回去。
Write-Host ">> Build public allow-list + redeploy $Project ..."
& node (Join-Path $Root "tools\scripts\build-pages-public.mjs") --out (Join-Path $Root "dist\pages-public")
if ($LASTEXITCODE -ne 0) { throw "build-pages-public failed (exit $LASTEXITCODE) - 疑似命中敏感规则，已中止部署" }
& npx wrangler pages deploy (Join-Path $Root "dist\pages-public") --project-name=$Project --commit-dirty=true
if ($LASTEXITCODE -ne 0) { throw "Deploy failed" }

Write-Host ">> Smoke test ..."
$payment = Invoke-RestMethod -Uri "$ApiBase/api/payment" -Method Get
$quota = Invoke-RestMethod -Uri "$ApiBase/api/quota?clientId=smoke_test" -Method Get
$health = Invoke-RestMethod -Uri "$ApiBase/api/health" -Method Get
Write-Host "payment API: OK (company=$($payment.company.name.Substring(0,6))...)"
Write-Host "quota API: OK storage=$($quota.storage) remaining=$($quota.remaining)"
Write-Host "health API: speechConfigured=$($health.speechConfigured) mailConfigured=$($health.mailConfigured)"

Write-Host ""
Write-Host "API:    $ApiBase" -ForegroundColor Green
Write-Host "Static: https://qtvq.cn (run sync-static.sh on Ubuntu after git pull)"
Write-Host "Staff:  $ApiBase/tools/verify-payment.html"
