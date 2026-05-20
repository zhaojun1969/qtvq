# Post-deploy: upload secrets from .dev.vars, redeploy, smoke test
# Usage: powershell -ExecutionPolicy Bypass -File scripts/post-deploy.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$whoami = & npx wrangler whoami 2>&1 | Out-String
if ($whoami -match 'not authenticated' -and -not $env:CLOUDFLARE_API_TOKEN) {
    Write-Host "ERROR: npx wrangler login first" -ForegroundColor Red
    exit 1
}

if (Test-Path ".dev.vars") {
    $line = Get-Content ".dev.vars" -Encoding UTF8 | Where-Object { $_ -match '^PAYMENT_ADMIN_KEY=' } | Select-Object -First 1
    if ($line -match '^PAYMENT_ADMIN_KEY=(.+)$') {
        $val = $Matches[1].Trim()
        Write-Host ">> Upload PAYMENT_ADMIN_KEY to Pages (qtvq) ..."
        $val | & npx wrangler pages secret put PAYMENT_ADMIN_KEY --project-name=qtvq
    }
} else {
    Write-Host "Skip secrets: no .dev.vars (copy from .dev.vars.example)" -ForegroundColor Yellow
}

Write-Host ">> Redeploy ..."
& npx wrangler pages deploy . --project-name=qtvq
if ($LASTEXITCODE -ne 0) { throw "Deploy failed" }

Write-Host ">> Smoke test ..."
$payment = Invoke-RestMethod -Uri "https://qtvq.pages.dev/api/payment" -Method Get
$quota = Invoke-RestMethod -Uri "https://qtvq.pages.dev/api/quota?clientId=smoke_test" -Method Get
Write-Host "payment API: OK (company=$($payment.company.name.Substring(0,6))...)"
Write-Host "quota API: OK storage=$($quota.storage) remaining=$($quota.remaining)"

Write-Host ""
Write-Host "Production: https://qtvq.pages.dev" -ForegroundColor Green
Write-Host "Staff verify: https://qtvq.pages.dev/tools/verify-payment.html"
Write-Host "Dashboard: bind Workers AI (AI), custom domain qtvq.cn"
