# 打包静态站（不上传），用于手动传到服务器解压
# 用法：powershell -ExecutionPolicy Bypass -File tools/scripts/package-static.ps1
# 服务器：sudo tar -xzf qtvq-static.tgz -C /var/www/qtvq

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

& (Join-Path $PSScriptRoot "write-version.ps1")

$outDir = Join-Path $Root "dist"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$tar = Join-Path $outDir "qtvq-static.tgz"
if (Test-Path $tar) { Remove-Item $tar -Force }

$stage = Join-Path $env:TEMP "qtvq-static-pack-$(Get-Date -Format 'yyyyMMddHHmmss')"
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$items = @(
    "index.html", "pitfalls.html", "profile.html", "help.html", "privacy.html", "download.html", "404.html",
    "css", "js", "assets",
    "robots.txt", "sitemap.xml", "_headers", "_redirects"
)
foreach ($item in $items) {
    if (Test-Path $item) { Copy-Item $item (Join-Path $stage $item) -Recurse -Force }
}

$required = @(
    "js/layout.js", "js/contact.js", "js/toast.js", "js/home.js", "js/voice-asr.js",
    "js/data.js", "js/pay-qr.js", "help.html", "download.html", "privacy.html"
)
foreach ($rel in $required) {
    $p = Join-Path $stage $rel
    if (-not (Test-Path $p)) { throw "缺少 $rel" }
}
$layout = Get-Content (Join-Path $stage "js/layout.js") -Raw -Encoding UTF8
$homeJs = Get-Content (Join-Path $stage "js/home.js") -Raw -Encoding UTF8
if ($layout -notmatch 'initContactModal') { throw "layout.js 未含 initContactModal" }
if ($homeJs -notmatch 'story-card-clickable') { throw "home.js 未含成功案例点击" }
if ($homeJs -notmatch 'voice-asr') { throw "home.js 未接入 voice-asr" }
$versionJs = Join-Path $stage "js/version.js"
if (-not (Test-Path $versionJs)) { throw "缺少 js/version.js，请先 write-version.ps1" }
if ((Get-Content $versionJs -Raw) -notmatch 'BUILD_SHA') { throw "version.js 格式异常" }
if (-not (Select-String -Path (Join-Path $stage "index.html") -Pattern 'feature-card-link' -Quiet)) {
    throw "index.html 未含 feature-card-link"
}
if (-not (Select-String -Path (Join-Path $stage "index.html") -Pattern 'footer-support' -Quiet)) {
    throw "index.html 未含 footer-support"
}
$dataJs = Get-Content (Join-Path $stage "js/data.js") -Raw -Encoding UTF8
if ($dataJs -notmatch 'prompt:') { throw "data.js 未含成功案例 prompt" }

& tar -czf $tar -C $stage .
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ">> 已打包: $tar" -ForegroundColor Green
Write-Host ">> 服务器解压: sudo tar -xzf qtvq-static.tgz -C /var/www/qtvq && sudo chown -R www-data:www-data /var/www/qtvq"
