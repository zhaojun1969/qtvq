# KV setup (if needed) + Pages deploy
# Usage: powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 [-SkipKv]

param(
    [switch]$SkipKv,
    [string]$ProjectName = "qtvq-api"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

function Test-WranglerAuth {
    $out = & npx wrangler whoami 2>&1 | Out-String
    if ($env:CLOUDFLARE_API_TOKEN) { return $true }
    return ($out -notmatch 'not authenticated')
}

Write-Host "=== QTVQ Pages Deploy ===" -ForegroundColor Cyan

if (-not (Test-WranglerAuth)) {
    Write-Host "ERROR: Not logged in. Run: npx wrangler login" -ForegroundColor Red
    Write-Host "Or set env CLOUDFLARE_API_TOKEN for CI."
    exit 1
}

if (-not $SkipKv) {
    $toml = Get-Content "wrangler.toml" -Raw -Encoding UTF8
    if ($toml -notmatch '\[\[kv_namespaces\]\]' -or $toml -notmatch 'id\s*=\s*"[a-f0-9]{32}"') {
        Write-Host ">> Running KV setup ..."
        & powershell -ExecutionPolicy Bypass -File (Join-Path $Root "tools\scripts\setup-kv.ps1")
    } else {
        Write-Host "KV already in wrangler.toml (use -SkipKv to skip)"
    }
}

if (-not (Test-Path ".dev.vars")) {
    Write-Host "Note: no .dev.vars - set PAYMENT_ADMIN_KEY in Dashboard for production." -ForegroundColor Yellow
}

Write-Host ">> Deploying to Cloudflare Pages ($ProjectName) ..."
$deployOut = & npx wrangler pages deploy . --project-name=$ProjectName 2>&1 | Out-String
Write-Host $deployOut
if ($LASTEXITCODE -ne 0 -and $deployOut -match 'Project not found|8000007') {
    Write-Host ">> Creating Pages project $ProjectName ..."
    & npx wrangler pages project create $ProjectName --production-branch=main
    $deployOut = & npx wrangler pages deploy . --project-name=$ProjectName 2>&1 | Out-String
    Write-Host $deployOut
}
if ($LASTEXITCODE -ne 0) { throw "Deploy failed." }

Write-Host ""
Write-Host "Deploy OK. Verify in Dashboard:" -ForegroundColor Green
Write-Host "  - Workers AI binding: AI"
Write-Host "  - KV binding: QTVQ_KV"
Write-Host "  - Env: PAYMENT_ADMIN_KEY"
Write-Host "  - API: https://qtvq-api.pages.dev"
Write-Host "  - Static: sync to qtvq.cn via tools/scripts/sync-static.sh"
Write-Host "  - Staff: https://qtvq-api.pages.dev/tools/verify-payment.html"
