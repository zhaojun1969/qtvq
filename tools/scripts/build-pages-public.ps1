# 构建 Cloudflare Pages 白名单发布目录（本项目公网可见内容的唯一权威来源）
#
# 为什么需要它（2026-09-13 事件复盘）：
#   deploy.ps1 原本执行 `wrangler pages deploy .`，把整个仓库当作静态站点发布出去。
#   结果下列内容在 https://qtvq-api.pages.dev 上公开可读（实测 HTTP 200）：
#     cf.env                        Cloudflare API Token（部署凭据）
#     obs.env                       阿里云 OSS AccessKeyId/SecretAccessKey
#     .dev.vars                     本地开发密钥
#     server/.env                   ADMIN_KEY / JWT_SECRET / Mongo URI / 模型密钥
#     context/CONTEXT-SNAPSHOT.md   内部路线图
#     tmp-chat.json                 对话导出
#     README.md / package.json / apps/ 小程序源码
#   注意 .assetsignore 在 wrangler 4.98 的 Pages 部署路径上实测**不生效**
#   （连 .assetsignore 自己都会被发布出去），因此本脚本不用排除法，只用显式白名单。
#   另注：Pages 对非 HTML 资源默认 `cache-control: public, s-maxage=604800`，
#   文件即使从新部署中移除，边缘缓存仍可能继续供应最长 7 天 —— 所以密钥泄露必须轮换，
#   只删文件只是止血。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/scripts/build-pages-public.ps1
#   powershell -ExecutionPolicy Bypass -File tools/scripts/build-pages-public.ps1 -OutDir dist/other

param(
    [string]$OutDir = "dist/pages-public"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

# ---- 允许公开的根文件 ----
$AllowFiles = @("*.html", "robots.txt", "sitemap.xml", "_headers", "_redirects")
# ---- 允许公开的目录（functions/ 是 API 本体，必须发布）----
$AllowDirs = @("js", "css", "assets", "logo", "functions")
# ---- tools/ 下允许公开的文件（工作人员核实页）----
$AllowTools = @("verify-payment.html")

# ---- 发布前闸门：命中即中止，绝不把可疑文件推上公网 ----
$ForbiddenNamePattern = '\.env$|\.env\.|^\.env|\.pem$|\.key$|\.p12$|\.pfx$|dev\.vars|secret|credential|\.tgz$|\.zip$|\.bak$'
# 私钥规则要求"头部 + 足够长的 base64 主体"，避免误伤 functions/lib/wechat-crypto.js 里的解析用字面量
$ForbiddenContentPattern = 'cfut_[A-Za-z0-9]{20}|LTAI[A-Za-z0-9]{12,}|gho_[A-Za-z0-9]{20}|ADMIN_KEY\s*=\s*\S|JWT_SECRET\s*=\s*\S|mongodb(\+srv)?://[^"\s]*:[^"\s]*@|-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40,}'

function Write-Step($m) { Write-Host ">> $m" -ForegroundColor Cyan }

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Step "复制白名单内容 -> $OutDir"
Copy-Item -Force $AllowFiles $OutDir -ErrorAction SilentlyContinue
foreach ($d in $AllowDirs) {
    if (-not (Test-Path $d)) { throw "缺少必要目录: $d" }
    Copy-Item -Recurse -Force $d $OutDir
}
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir "tools") | Out-Null
foreach ($f in $AllowTools) {
    $src = Join-Path "tools" $f
    if (-not (Test-Path $src)) { throw "缺少必要文件: $src" }
    Copy-Item -Force $src (Join-Path $OutDir "tools")
}

Write-Step "发布前敏感检查"
$files = @(Get-ChildItem -Recurse -File $OutDir)
$bad = @()
$bad += @($files | Where-Object { $_.Name -match $ForbiddenNamePattern } | ForEach-Object { "名称命中: " + $_.FullName })
$bad += @($files | Select-String -Pattern $ForbiddenContentPattern -ErrorAction SilentlyContinue | ForEach-Object { "内容命中: " + $_.Path + ":" + $_.LineNumber })
if ($bad.Count -gt 0) {
    Write-Host "拒绝发布 —— 命中敏感规则：" -ForegroundColor Red
    $bad | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}

# 关键文件必须在场：少一个都会让线上功能或安全配置坏掉
$must = @(
    "functions/api/payment.js",
    "functions/lib/order-store.js",
    "functions/lib/wechat-crypto.js",
    "_headers",
    "_redirects",
    "index.html",
    "js/config.js",
    "css/styles.css",
    "tools/verify-payment.html"
)
foreach ($m in $must) {
    if (-not (Test-Path (Join-Path $OutDir $m))) { throw "关键文件缺失: $m" }
}

Write-Host ("   文件数 " + $files.Count + "，敏感规则 0 命中") -ForegroundColor Green
Write-Host ("   输出目录 " + (Resolve-Path $OutDir).Path) -ForegroundColor Green
Write-Host "   提示：/api/* 的 no-store 由 _headers 提供，务必保留该文件" -ForegroundColor DarkGray
