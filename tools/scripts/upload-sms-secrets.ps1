# Upload SMS (Aliyun Dysmsapi) secrets from .dev.vars to Cloudflare Pages (qtvq-api)
# Usage: powershell -ExecutionPolicy Bypass -File tools/scripts/upload-sms-secrets.ps1

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

if (-not (. (Join-Path $PSScriptRoot "load-cf-env.ps1"))) {
    Write-Host "WARN: cf.env not loaded, using wrangler login cache" -ForegroundColor Yellow
}

$Project = "qtvq-api"

$secretKeys = @(
    "ALIYUN_SMS_ACCESS_KEY_ID",
    "ALIYUN_SMS_ACCESS_KEY_SECRET",
    "SMS_SIGN_NAME",
    "SMS_TEMPLATE_CODE"
)

# 短信的值都是单行，不存在多行 PEM 的取值陷阱；但仍要求"找不到就明确失败"，
# 避免把空值推上线（空值会让 isSmsConfigured 为 false，前端入口直接消失，很难排查）。
function Get-DevVarValue {
    param([string[]]$Lines, [string]$Key)
    foreach ($line in $Lines) {
        if (-not $line.StartsWith("${Key}=")) { continue }
        return $line.Substring($Key.Length + 1).Trim()
    }
    return $null
}

if (-not (Test-Path ".dev.vars")) {
    Write-Host "ERROR: missing .dev.vars" -ForegroundColor Red
    exit 1
}

$lines = Get-Content ".dev.vars" -Encoding UTF8
$uploaded = 0
$missing = @()

foreach ($key in $secretKeys) {
    $val = Get-DevVarValue -Lines $lines -Key $key
    if (-not $val) { $missing += $key; continue }
    if ($val -match '^#|请填写|请替换|xxxx') { $missing += $key; continue }

    Write-Host ">> Upload $key ..."
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        # 必须按 UTF-8 无 BOM 写文件，并且**用文件重定向而不是 PowerShell 管道**喂给 wrangler。
        #
        # 原因（2026-09-17 实际踩到）：Windows PowerShell 5.1 的 $OutputEncoding 默认是 ASCII，
        # 通过管道把值传给外部程序时**中文会被替换成 "?"**。SMS_SIGN_NAME 是中文，
        # 于是线上签名变成 "???"，阿里云返回 isv.SMS_SIGNATURE_ILLEGAL「该账号下找不到对应签名」，
        # 而在阿里云控制台里这个签名明明是「审核通过」——现象与原因南辕北辙。
        # 微信那批密钥全是 ASCII，所以这个坑直到第一个中文密钥才暴露。
        [System.IO.File]::WriteAllText($tmp, $val, [System.Text.UTF8Encoding]::new($false))
        $prevOutputEncoding = $OutputEncoding
        $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        try {
            cmd /c "npx wrangler pages secret put $key --project-name=$Project < `"$tmp`""
        } finally {
            $OutputEncoding = $prevOutputEncoding
        }
        if ($LASTEXITCODE -ne 0) { throw "wrangler exit $LASTEXITCODE" }
        $uploaded++
    } catch {
        Write-Host "ERROR: upload $key failed: $_" -ForegroundColor Red
        exit 1
    } finally {
        Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
    }
}

if ($missing.Count -gt 0) {
    Write-Host "MISSING in .dev.vars: $($missing -join ', ')" -ForegroundColor Yellow
}
Write-Host ">> Uploaded $uploaded SMS secret(s). 记得重新部署：node tools/scripts/deploy.ps1" -ForegroundColor Green
