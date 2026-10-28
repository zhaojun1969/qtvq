# 上传语音识别（阿里云 NLS）相关密钥到 Cloudflare Pages (qtvq-api)
# Usage: powershell -ExecutionPolicy Bypass -File tools/scripts/upload-speech-secrets.ps1
#
# 2026-09-17 重写：原来只推 NLS_APP_KEY，于是"给语音单独配一把 AK"根本推不上去
# （AK 填进 .dev.vars 也不生效，而现象是 40020503 No permission! —— 会让人一直以为是权限没授对）。
# 现在推三个：NLS_APP_KEY + NLS_ACCESS_KEY_ID + NLS_ACCESS_KEY_SECRET。
# 代码侧凭据优先级（functions/lib/aliyun-nls.js）：NLS_* → ALIYUN_* → OSS_* 兜底。

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

. (Join-Path $PSScriptRoot "load-cf-env.ps1") | Out-Null
$Project = "qtvq-api"

if (-not (Test-Path ".dev.vars")) {
    Write-Host "ERROR: 无 .dev.vars" -ForegroundColor Red
    exit 1
}

$lines = Get-Content ".dev.vars" -Encoding UTF8

function Get-DevVarValue {
    param([string[]]$Lines, [string]$Key)
    foreach ($line in $Lines) {
        if (-not $line.StartsWith("${Key}=")) { continue }
        return $line.Substring($Key.Length + 1).Trim()
    }
    return $null
}

$required = @("NLS_APP_KEY", "NLS_ACCESS_KEY_ID", "NLS_ACCESS_KEY_SECRET")
$values = @{}
$missing = @()
foreach ($k in $required) {
    $v = Get-DevVarValue -Lines $lines -Key $k
    if (-not $v -or $v -match 'placeholder|example|xxxxxxxx|请填写|请替换') { $missing += $k; continue }
    $values[$k] = $v
}

if ($missing.Count -gt 0) {
    Write-Host "ERROR: .dev.vars 缺少（或仍是占位值）：$($missing -join ', ')" -ForegroundColor Red
    Write-Host "  语音识别需要三件套：NLS_APP_KEY（控制台项目里复制）+ 一组有 NLS 权限的 AccessKey。" -ForegroundColor Yellow
    Write-Host "  详见 docs/计划书对齐与整改实施方案.md §9.27" -ForegroundColor Yellow
    exit 1
}

foreach ($k in $required) {
    Write-Host ">> Upload $k ..."
    # 文件重定向而不是 PowerShell 管道：PS 5.1 管道默认 ASCII 编码，中文/特殊字符会被破坏
    # （SMS_SIGN_NAME 就这么被推坏过一次）。这些值理论上都是 ASCII，但保持一致更安全。
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($tmp, $values[$k], [System.Text.UTF8Encoding]::new($false))
        cmd /c "npx wrangler pages secret put $k --project-name=$Project < `"$tmp`""
        if ($LASTEXITCODE -ne 0) { throw "wrangler exit $LASTEXITCODE" }
    } finally {
        Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
    }
}
$values.Clear()

Write-Host ">> 已上传 3 个语音密钥。密钥变更必须重新部署才生效：" -ForegroundColor Green
Write-Host "   node tools/scripts/deploy.ps1" -ForegroundColor Green
Write-Host "   然后验证：node tools/scripts/check-speech-chain.mjs" -ForegroundColor Green
Write-Host "   （期望 GET /api/speech 返回 ready:true；POST 静音返回 422「未识别到有效语音」= 链路通）" -ForegroundColor Green
