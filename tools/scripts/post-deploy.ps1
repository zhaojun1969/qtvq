# Post-deploy: upload secrets from .dev.vars, redeploy qtvq-api, smoke test
# Usage: powershell -ExecutionPolicy Bypass -File tools/scripts/post-deploy.ps1

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

$Project = "qtvq-api"
$ApiBase = "https://qtvq-api.pages.dev"

$whoami = & npx wrangler whoami 2>&1 | Out-String
if ($whoami -match 'not authenticated' -and -not $env:CLOUDFLARE_API_TOKEN) {
    Write-Host "ERROR: npx wrangler login first" -ForegroundColor Red
    exit 1
}

if (Test-Path ".dev.vars") {
    $line = Get-Content ".dev.vars" -Encoding UTF8 | Where-Object { $_ -match '^PAYMENT_ADMIN_KEY=' } | Select-Object -First 1
    if ($line -match '^PAYMENT_ADMIN_KEY=(.+)$') {
        $val = $Matches[1].Trim()
        Write-Host ">> Upload PAYMENT_ADMIN_KEY to Pages ($Project) ..."
        $val | & npx wrangler pages secret put PAYMENT_ADMIN_KEY --project-name=$Project
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
Write-Host "payment API: OK (company=$($payment.company.name.Substring(0,6))...)"
Write-Host "quota API: OK storage=$($quota.storage) remaining=$($quota.remaining)"

Write-Host ""
Write-Host "API:    $ApiBase" -ForegroundColor Green
Write-Host "Static: https://qtvq.cn (run sync-static.sh on Ubuntu after git pull)"
Write-Host "Staff:  $ApiBase/tools/verify-payment.html"
