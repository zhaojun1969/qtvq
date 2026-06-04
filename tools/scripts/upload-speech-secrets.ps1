# Upload NLS speech secret from .dev.vars to Cloudflare Pages (qtvq-api)
# Usage: powershell -ExecutionPolicy Bypass -File tools/scripts/upload-speech-secrets.ps1

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

. (Join-Path $PSScriptRoot "load-cf-env.ps1") | Out-Null
$Project = "qtvq-api"

if (-not (Test-Path ".dev.vars")) {
    Write-Host "ERROR: 无 .dev.vars，请先填写 NLS_APP_KEY" -ForegroundColor Red
    Write-Host "  见 docs/SPEECH-ASR.md"
    exit 1
}

$lines = Get-Content ".dev.vars" -Encoding UTF8
$line = $lines | Where-Object { $_ -match '^NLS_APP_KEY=' } | Select-Object -First 1
if (-not $line -or $line -notmatch '^NLS_APP_KEY=(.+)$') {
    Write-Host "ERROR: .dev.vars 中缺少 NLS_APP_KEY=" -ForegroundColor Red
    exit 1
}

$val = $Matches[1].Trim()
if (-not $val -or $val.Length -lt 8 -or $val -match 'placeholder|example|xxxxxxxx') {
    Write-Host "ERROR: NLS_APP_KEY invalid or placeholder" -ForegroundColor Yellow
    exit 1
}

Write-Host ">> Upload NLS_APP_KEY ..."
$val | & npx wrangler pages secret put NLS_APP_KEY --project-name=$Project
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ">> Done. Redeploy: npm run deploy:api-only" -ForegroundColor Green
Write-Host ">> Verify: curl https://qtvq-api.pages.dev/api/health  (speechConfigured: true)"
