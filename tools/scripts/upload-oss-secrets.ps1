# 把 obs.env 里的阿里云 OSS 凭据推送为 Cloudflare Pages 项目密钥（qtvq-api）
#
# 为什么需要它：线上 functions/lib/oss-backup.js、functions/api/backup-sync.js 在运行时
# 读的是 **Pages 项目密钥** OSS_ACCESS_KEY_ID / OSS_SECRET_ACCESS_KEY / OSS_ENDPOINT / OSS_BUCKET，
# 而不是仓库里的 obs.env。所以轮换 OSS AK 时，除了改本地 obs.env，还必须把新值推上去，
# 否则「OSS 备份降级读取/写入」会静默失败。仓库里 mail / wechat / speech 都有这样的推送脚本，
# 唯独 OSS 没有 —— 本文件补上这个缺口。
#
# 注意变量名映射：obs.env 用 OBS_* 前缀，Pages 侧用 OSS_* 前缀，不要混。
# 注意 OSS_BACKUP_PREFIX 不在这里推送：它在 obs.env 里没有对应项（obs.env 的 OBS_PREFIX
# 是 qtvq/context/，语义不同），保持 Pages 上已有的值即可。
#
# 用法：powershell -ExecutionPolicy Bypass -File tools/scripts/upload-oss-secrets.ps1 [-DryRun]

param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

. (Join-Path $PSScriptRoot "load-cf-env.ps1") | Out-Null
$Project = "qtvq-api"

# obs.env 里的键 -> Pages 密钥名
$map = @{
    "OBS_ACCESS_KEY_ID"     = "OSS_ACCESS_KEY_ID"
    "OBS_SECRET_ACCESS_KEY" = "OSS_SECRET_ACCESS_KEY"
    "OBS_ENDPOINT"          = "OSS_ENDPOINT"
    "OBS_BUCKET"            = "OSS_BUCKET"
}

if (-not (Test-Path "obs.env")) {
    Write-Host "ERROR: 无 obs.env，请先复制 obs.env.example 并填写 OBS_ACCESS_KEY_ID / OBS_SECRET_ACCESS_KEY" -ForegroundColor Red
    exit 1
}

$lines = Get-Content "obs.env" -Encoding UTF8
$uploaded = 0

foreach ($srcKey in $map.Keys) {
    $dstKey = $map[$srcKey]
    $line = $lines | Where-Object { $_ -match "^\s*${srcKey}\s*=" } | Select-Object -First 1
    if (-not $line) {
        Write-Host "   skip $dstKey （obs.env 里没有 $srcKey）" -ForegroundColor DarkGray
        continue
    }
    $val = ($line -replace "^\s*${srcKey}\s*=\s*", "").Trim().Trim('"').Trim("'")
    if (-not $val -or $val -match '你的|请填写|请替换|xxxxxxxx') {
        Write-Host "   skip $dstKey （值仍是占位符）" -ForegroundColor DarkGray
        continue
    }
    if ($DryRun) {
        Write-Host ("   [DryRun] " + $dstKey + " <- " + $srcKey + " (" + $val.Length + " 字符)")
        continue
    }
    Write-Host ">> Upload $dstKey ..." -ForegroundColor Cyan
    $val | & npx wrangler pages secret put $dstKey --project-name=$Project
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $uploaded++
}

if ($DryRun) {
    Write-Host ""
    Write-Host "DryRun 结束，未做任何修改。去掉 -DryRun 才会真正推送。" -ForegroundColor Yellow
    exit 0
}

if ($uploaded -eq 0) {
    Write-Host "未上传任何 OSS Secret：请检查 obs.env 里的值是否有效" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host (">> 已上传 $uploaded 个 OSS secret。") -ForegroundColor Green
Write-Host "   验证：GET  https://qtvq-api.pages.dev/api/backup-sync   → ossConfigured 应为 true" -ForegroundColor Green
Write-Host "   端到端：POST https://qtvq-api.pages.dev/api/backup-sync?adminKey=<PAYMENT_ADMIN_KEY> -d '{\"action\":\"static\"}'" -ForegroundColor Green
