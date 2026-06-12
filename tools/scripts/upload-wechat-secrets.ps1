# Upload WeChat Pay secrets from .dev.vars to Cloudflare Pages (qtvq-api)
# Usage: powershell -ExecutionPolicy Bypass -File tools/scripts/upload-wechat-secrets.ps1

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

if (-not (. (Join-Path $PSScriptRoot "load-cf-env.ps1"))) {
    Write-Host "WARN: cf.env not loaded, using wrangler login cache" -ForegroundColor Yellow
}

$Project = "qtvq-api"

$secretKeys = @(
    "WECHAT_MCH_ID",
    "WECHAT_APP_ID",
    "WECHAT_API_V3_KEY",
    "WECHAT_MCH_SERIAL",
    "WECHAT_MCH_PRIVATE_KEY",
    "WECHAT_PAY_NOTIFY_URL",
    "WECHAT_PLATFORM_PUBLIC_KEY"
)

function Get-DevVarValue {
    param([string[]]$Lines, [string]$Key)
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $line = $Lines[$i]
        if ($line -notmatch "^${Key}=") { continue }
        $value = ($line -replace "^${Key}=", "").Trim()
        if ($value -match '-----BEGIN') {
            $parts = @($value)
            for ($j = $i + 1; $j -lt $Lines.Count; $j++) {
                if ($Lines[$j] -match '^[A-Z][A-Z0-9_]+=') { break }
                $parts += $Lines[$j]
                if ($Lines[$j] -match '-----END') { break }
            }
            return ($parts -join "`n").Trim()
        }
        return $value
    }
    return $null
}

function Put-PagesSecret {
    param([string]$Key, [string]$Value)
    if ($Key -eq 'WECHAT_MCH_PRIVATE_KEY') {
        $normScript = Join-Path $PSScriptRoot "normalize-wechat-pem.js"
        $Value = ($Value | node $normScript)
        if ($LASTEXITCODE -ne 0) { throw "normalize-wechat-pem failed" }
    }
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($tmp, $Value, [System.Text.UTF8Encoding]::new($false))
        Get-Content -Path $tmp -Raw -Encoding UTF8 | & npx wrangler pages secret put $Key --project-name=$Project
        if ($LASTEXITCODE -ne 0) { throw "wrangler exit $LASTEXITCODE" }
    } finally {
        Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path ".dev.vars")) {
    Write-Host "ERROR: missing .dev.vars" -ForegroundColor Red
    exit 1
}

$lines = Get-Content ".dev.vars" -Encoding UTF8
$uploaded = 0

foreach ($key in $secretKeys) {
    $val = Get-DevVarValue -Lines $lines -Key $key
    if (-not $val -or $val -match '^#|请填写|请替换|xxxxxxxx') { continue }
    Write-Host ">> Upload $key ..."
    try {
        Put-PagesSecret -Key $key -Value $val
        $uploaded++
    } catch {
        Write-Host "ERROR: upload $key failed: $_" -ForegroundColor Red
        exit 1
    }
}

if ($uploaded -eq 0) {
    Write-Host "No WeChat secrets uploaded (uncomment keys in .dev.vars)" -ForegroundColor Yellow
    exit 1
}

Write-Host ">> Uploaded $uploaded WeChat secret(s). Run: npm run deploy:api-only" -ForegroundColor Green
