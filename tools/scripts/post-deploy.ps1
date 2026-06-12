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
    $mailKeys = @('MAIL_PROVIDER','SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASS','SMTP_FROM','SMTP_TO','RESEND_API_KEY','MAIL_FROM','MAIL_TO')
    foreach ($key in $mailKeys) {
        $mline = $lines | Where-Object { $_ -match "^${key}=" } | Select-Object -First 1
        if ($mline -match "^${key}=(.+)$") {
            $mval = $Matches[1].Trim()
            if ($mval -and $mval -notmatch '请填写|请替换|xxxxxxxx') {
                Write-Host ">> Upload $key ..."
                $mval | & npx wrangler pages secret put $key --project-name=$Project
            }
        }
    }
    $nlsLine = $lines | Where-Object { $_ -match '^NLS_APP_KEY=' } | Select-Object -First 1
    if ($nlsLine -match '^NLS_APP_KEY=(.+)$') {
        $nlsVal = $Matches[1].Trim()
        if ($nlsVal -and $nlsVal.Length -ge 8 -and $nlsVal -notmatch 'placeholder|example|xxxxxxxx') {
            Write-Host ">> Upload NLS_APP_KEY ..."
            $nlsVal | & npx wrangler pages secret put NLS_APP_KEY --project-name=$Project
        }
    }
    $wechatKeys = @('WECHAT_MCH_ID','WECHAT_APP_ID','WECHAT_API_V3_KEY','WECHAT_MCH_SERIAL','WECHAT_MCH_PRIVATE_KEY','WECHAT_PAY_NOTIFY_URL','WECHAT_PLATFORM_PUBLIC_KEY')
    foreach ($key in $wechatKeys) {
        $wline = $lines | Where-Object { $_ -match "^${key}=" } | Select-Object -First 1
        if ($wline -match "^${key}=(.+)$") {
            $wval = $Matches[1].Trim()
            if ($wval -and $wval -notmatch '^#|请填写|请替换|xxxxxxxx') {
                Write-Host ">> Upload $key ..."
                $wval | & npx wrangler pages secret put $key --project-name=$Project
            }
        }
    }
} else {
    Write-Host "Skip secrets: no .dev.vars (copy from .dev.vars.example)" -ForegroundColor Yellow
}

Write-Host ">> Redeploy $Project ..."
& npx wrangler pages deploy . --project-name=$Project
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
