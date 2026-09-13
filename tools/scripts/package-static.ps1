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
    "index.html", "pitfalls.html", "profile.html", "report.html", "wheel.html", "help.html", "privacy.html", "download.html", "404.html",
    "css", "js", "assets", "logo",
    "robots.txt", "sitemap.xml", "_headers", "_redirects"
)
foreach ($item in $items) {
    if (Test-Path $item) { Copy-Item $item (Join-Path $stage $item) -Recurse -Force }
}

& (Join-Path $PSScriptRoot "copy-verify-root.ps1") -Stage $stage -Root $Root

$required = @(
    "js/layout.js", "js/contact.js", "js/toast.js", "js/home.js", "js/voice-asr.js",
    "js/data.js", "js/pay-qr.js", "help.html", "download.html", "privacy.html",
    # 配对报告页（路线B）：页面 + 三个模块 + 专用样式，缺任何一个都会白屏
    "report.html", "js/report.js", "js/report-api.js", "js/report-share.js", "css/report.css",
    # 转盘页：同样一个都不能少；js/wheel.js 不含任何前端抽签逻辑，落点由服务端给
    "wheel.html", "js/wheel.js", "css/wheel.css"
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

# 配对报告页关键内容校验：样式引用、API 客户端挂载点、分享出图入口
$reportHtml = Get-Content (Join-Path $stage "report.html") -Raw -Encoding UTF8
if ($reportHtml -notmatch 'css/report\.css') { throw "report.html 未引用 css/report.css" }
if ($reportHtml -notmatch 'js/report\.js') { throw "report.html 未引用 js/report.js" }
if ($reportHtml -notmatch 'id="profile-form"') { throw "report.html 缺少资料表单" }
$reportJs = Get-Content (Join-Path $stage "js/report.js") -Raw -Encoding UTF8
if ($reportJs -notmatch 'report-share\.js') { throw "js/report.js 未接入分享长图" }
$reportApi = Get-Content (Join-Path $stage "js/report-api.js") -Raw -Encoding UTF8
if ($reportApi -notmatch '/v1/health') { throw "js/report-api.js 未指向新报告服务" }
if ((Get-Content (Join-Path $stage "index.html") -Raw) -notmatch 'report\.html') { throw "首页未加入配对报告入口" }
if ((Get-Content (Join-Path $stage "index.html") -Raw) -notmatch 'wheel\.html') { throw "首页未加入转盘入口" }

# 转盘页关键校验：必须引用专用样式与脚本，且**不得**出现前端决定落点的写法
$wheelHtml = Get-Content (Join-Path $stage "wheel.html") -Raw -Encoding UTF8
if ($wheelHtml -notmatch 'css/wheel\.css') { throw "wheel.html 未引用 css/wheel.css" }
if ($wheelHtml -notmatch 'js/wheel\.js') { throw "wheel.html 未引用 js/wheel.js" }
if ($wheelHtml -notmatch 'wheel-canvas') { throw "wheel.html 缺少 canvas" }
$wheelJs = Get-Content (Join-Path $stage "js/wheel.js") -Raw -Encoding UTF8
if ($wheelJs -notmatch 'animateTo') { throw "js/wheel.js 未实现落点动画" }
if ($wheelJs -match 'Math\.random\(\)\s*\* *n') { throw "js/wheel.js 出现前端随机决定落点的写法——抽签必须由服务端决定" }

& tar -czf $tar -C $stage .
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ">> 已打包: $tar" -ForegroundColor Green
Write-Host ">> 服务器解压: sudo tar -xzf qtvq-static.tgz -C /var/www/qtvq && sudo chown -R www-data:www-data /var/www/qtvq"
