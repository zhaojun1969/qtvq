# 写入 js/version.js（部署/同步前调用，便于线上核对版本）
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

$sha = (git rev-parse --short HEAD 2>$null)
if (-not $sha) { $sha = "unknown" }
$time = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$content = @"
/** 自动生成，勿手改 */
export const BUILD_SHA = '$sha';
export const BUILD_TIME = '$time';
"@

Set-Content -Path "js/version.js" -Value $content -Encoding UTF8
Write-Host "version.js -> $sha @ $time"
