# KV setup (if needed) + Pages deploy
# Usage: powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 [-SkipKv]

param(
    [switch]$SkipKv,
    [string]$ProjectName = "qtvq-api"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

. (Join-Path $PSScriptRoot "load-cf-env.ps1") | Out-Null
if (-not $env:CLOUDFLARE_ACCOUNT_ID) {
    $env:CLOUDFLARE_ACCOUNT_ID = "bb7eb342a5cfde7c0a84cd9bd519a859"
}

function Test-WranglerAuth {
    if ($env:CLOUDFLARE_API_TOKEN) { return $true }
    $null = & npx wrangler whoami 2>&1 | Out-String
    return ($LASTEXITCODE -eq 0)
}

function Invoke-Wrangler {
    param([string[]]$Args)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $out = & npx @Args 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -ne 0) { Write-Host $out; throw "wrangler failed (exit $code)" }
    return $out
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
$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& npx wrangler pages deploy . --project-name=$ProjectName --commit-dirty=true
$code = $LASTEXITCODE
$ErrorActionPreference = $prev
if ($code -ne 0) { throw "Deploy failed (exit $code)" }

Write-Host ""
Write-Host "Deploy OK. Verify in Dashboard:" -ForegroundColor Green
Write-Host "  - Workers AI binding: AI"
Write-Host "  - KV binding: QTVQ_KV"
Write-Host "  - Env: PAYMENT_ADMIN_KEY"
Write-Host "  - API: https://qtvq-api.pages.dev"
Write-Host "  - Static: sync to qtvq.cn via tools/scripts/sync-static.sh"
Write-Host "  - Staff: https://qtvq-api.pages.dev/tools/verify-payment.html"
