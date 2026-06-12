# Upload mail-related secrets from .dev.vars to Cloudflare Pages (qtvq-api)
# Usage: powershell -ExecutionPolicy Bypass -File tools/scripts/upload-mail-secrets.ps1

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

. (Join-Path $PSScriptRoot "load-cf-env.ps1") | Out-Null
$Project = "qtvq-api"

$secretKeys = @(
    "MAIL_PROVIDER",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASS",
    "SMTP_FROM",
    "SMTP_TO",
    "RESEND_API_KEY",
    "MAIL_FROM",
    "MAIL_TO"
)

if (-not (Test-Path ".dev.vars")) {
    Write-Host "ERROR: 无 .dev.vars，请先复制 .dev.vars.example 并填写 SMTP 变量" -ForegroundColor Red
    Write-Host "  见 docs/MAIL-SMTP.md"
    exit 1
}

$lines = Get-Content ".dev.vars" -Encoding UTF8
$uploaded = 0

foreach ($key in $secretKeys) {
    $line = $lines | Where-Object { $_ -match "^${key}=" } | Select-Object -First 1
    if (-not $line) { continue }
    if ($line -match "^${key}=(.+)$") {
        $val = $Matches[1].Trim()
        if (-not $val -or $val -match '请填写|请替换|xxxxxxxx') { continue }
        Write-Host ">> Upload $key ..."
        $val | & npx wrangler pages secret put $key --project-name=$Project
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $uploaded++
    }
}

if ($uploaded -eq 0) {
    Write-Host "未上传任何邮件 Secret：请检查 .dev.vars 中 SMTP_PASS 等是否已填写" -ForegroundColor Yellow
    exit 1
}

Write-Host ">> Uploaded $uploaded mail secret(s). Redeploy: npm run deploy:api-only" -ForegroundColor Green
