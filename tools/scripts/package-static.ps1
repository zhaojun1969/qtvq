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

# 根目录的所有页面：用通配符自动纳入，而不是手写清单。
# 2026-09-16 实际踩过：手写清单漏了 account.html 与 wechat-callback.html，
# 导致这两个页面**从未被这条部署通道更新过**（account.html 的菜单一直是旧的）。
$htmlPages = Get-ChildItem -Path $Root -File -Filter "*.html" | ForEach-Object { $_.Name }

$items = @($htmlPages) + @(
    "css", "js", "assets", "logo",
    # `packages` 是跨端共享规则的唯一来源（2026-10-11 新建）。
    # 网页端 `js/pay-qr.js` 现在从 `../packages/shared/src/index.js` 再导出，
    # 所以**必须**把它打进静态包，否则线上 404、收款渠道整块失效。
    # 注意：这里写单段路径 `packages`（而不是 `packages/shared`）——
    # 多段子路径要依赖下面的"先建父目录"分支，实测那条分支对**目录**不生效（Copy-Item 抛 DirectoryNotFoundException）。
    "packages",
    # 运营页面：**只发 verify-payment.html 这一个文件**，绝不整目录复制。
    # 2026-09-18 踩到两件事：
    #   ① 审核页原先只在 qtvq-api.pages.dev 上，主站 qtvq.cn/tools/verify-payment.html 返回 404，
    #      业务方"找不到人工审核入口" —— 不是不会用，是入口没在自家域名上；
    #   ② 我第一版直接写了 "tools"，结果把 tools/scripts/ 下上百个内部脚本一并打进公网包
    #      （诊断工具、密钥装配脚本…）。**要发布的是页面，不是工具箱。**
    "tools/verify-payment.html",
    "tools/_headers",
    "robots.txt", "sitemap.xml", "_headers", "_redirects"
)
foreach ($item in $items) {
    if (-not (Test-Path $item)) { continue }
    $dest = Join-Path $stage $item
    # 支持子路径（如 tools/verify-payment.html）：先确保目标父目录存在，
    # 否则 Copy-Item 会抛 DirectoryNotFoundException（2026-09-18 实际踩到）。
    $destDir = Split-Path $dest -Parent
    if ($destDir -and -not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
    Copy-Item $item $dest -Recurse -Force
}

& (Join-Path $PSScriptRoot "copy-verify-root.ps1") -Stage $stage -Root $Root

# 各端自动更新的版本清单：/release/version.json
# App 与 H5/桌面端靠它判断"有没有新版本"，所以必须和静态站一起发布（同域，无需额外 nginx 配置）。
# 生成失败不让整包失败 —— 但那意味着 App 的自动更新拿不到数据，所以要显式告警而不是静默跳过。
# 各端自动更新的版本清单：/release/version.json
# App 与 H5/桌面端靠它判断"有没有新版本"，所以必须和静态站一起发布（同域，无需额外 nginx 配置）。
#
# ⚠️ **只复制 version.json 这一个文件**，绝不整目录复制 release/。
# 2026-09-20 实际踩到：桌面安装包（两个 exe，共 157MB）曾被暂存到 release/desktop/ 下，
# 整目录复制把它们打进了静态包 —— 包从 0.8MB 变成 158.7MB，每次发静态站都要多传 157MB，
# 而且 builder-debug.yml（含本机路径）也一并上了公网。
# 安装包改由 tools/scripts/upload-desktop-ssh.ps1 单独上传，不进静态包。
& node (Join-Path $PSScriptRoot "write-release-manifest.mjs")
$releaseJson = Join-Path $Root "dist\pages-public\release\version.json"
if (-not (Test-Path $releaseJson)) {
    throw "release/version.json 未生成（App/H5 的自动更新会拿不到版本信息）"
}
$releaseDest = Join-Path $stage "release"
New-Item -ItemType Directory -Force -Path $releaseDest | Out-Null
Copy-Item $releaseJson (Join-Path $releaseDest "version.json") -Force
$mjson = Get-Content (Join-Path $releaseDest "version.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $mjson.web.build) { throw "release/version.json 缺少 web.build（H5/桌面轮询判据）" }
Write-Host ">> 已纳入自动更新清单: release/version.json（web.build=$($mjson.web.build)）" -ForegroundColor Green

# 防呆：根目录的每个 .html 都必须进包，漏一个就直接失败（别再让页面静默不更新）
# ===== 静态资源指纹（cache-busting）=====
# 2026-10-11：给 js/css 加上 no-cache 之后，业务方**仍然看到旧样式**。
# 原因：旧响应是在加头**之前**被浏览器缓存进去的，浏览器在启发式新鲜期内不会回来校验，
#       no-cache 头只对"之后发生的请求"生效 —— 已经躺在本地的副本不吃这一套。
# 唯一能把已缓存 URL 顶掉的办法就是**换一个 URL**：打包时给 HTML 引用的 css/js 入口
# 统一追加 `?v=<styles.css 内容哈希前 8 位>`。文件一变 URL 就变，用户无需 Ctrl+F5。
# 版本号必须覆盖**所有** css 与 js —— 只哈希 styles.css 会导致"只改了 JS 时 URL 不变"，
# 浏览器继续用缓存里的旧 JS，修复看起来像没生效（2026-10-11 实际踩到：改完 wallet 逻辑
# 版本号仍是 0be2e415，与上一版相同）。这里把所有 css/js 的哈希拼起来再取一次哈希。
# 实现已抽到 `inject-asset-version.ps1`：**打包与直接同步源站两条通道共用同一份**。
# 2026-10-28 抽出的原因：这段原来只在这里，而线上真正在跑的是 `sync-static-from-windows.ps1`
# （scp 到阿里云源站）—— 那条通道完全没走这段，于是线上首页从来没有 `?v=`，
# `check-cache-policy.mjs` 判红。同一件事有两份实现，就一定会有一份漏掉。
$assetVer = & (Join-Path $PSScriptRoot "inject-asset-version.ps1") -Stage $stage
if (-not $assetVer) {
    throw "静态资源指纹注入失败（inject-asset-version.ps1 没有返回版本号）"
}
Write-Host ">> 静态资源版本号: $assetVer" -ForegroundColor DarkGray
$missingPages = @($htmlPages | Where-Object { -not (Test-Path (Join-Path $stage $_)) })
if ($missingPages.Count -gt 0) {
    throw "以下页面未打进静态包: " + ($missingPages -join ', ')
}

# 防呆：静态包里**不允许**出现大体积文件（安装包不属于静态站，见上面的说明）
$bigFiles = @(Get-ChildItem $stage -Recurse -File | Where-Object { $_.Length -gt 20MB })
if ($bigFiles.Count -gt 0) {
    throw "静态包内出现大于 20MB 的文件：" + (($bigFiles | ForEach-Object { "$($_.Name)($([math]::Round($_.Length/1MB,1))MB)" }) -join ', ') + " —— 安装包不应进静态包"
}

$required = @(
    "js/layout.js", "js/contact.js", "js/toast.js", "js/home.js", "js/voice-asr.js",
    "js/data.js", "js/pay-qr.js", "help.html", "download.html", "privacy.html",
    # 配对报告页（路线B）：页面 + 三个模块 + 专用样式，缺任何一个都会白屏
    "report.html", "js/report.js", "js/report-api.js", "js/report-share.js", "css/report.css",
    # 转盘页：同样一个都不能少；js/wheel.js 不含任何前端抽签逻辑，落点由服务端给
    "wheel.html", "js/wheel.js", "css/wheel.css",
    # 增长落地页（投放专用）：页面 + 案例表 + 样式 + 脚本，缺一个落地页就白屏
    "land.html", "js/land.js", "js/land-cases.js", "css/land.css"
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

# 举报原因必须是白名单选择，不能再回到 prompt 自由文本（服务端会 400 E_BAD_REASON）
# 注意：必须先去掉注释再匹配。第一版直接匹配 'prompt(' ，结果被自己写的那句注释
# 「之前这里用 prompt() 让用户手打」命中，报了一次假阳性。
$wheelNoComments = ($wheelJs -replace '(?s)/\*.*?\*/', ' ') -replace '(?m)//.*$', ' '
if ($wheelNoComments -match 'prompt\(') { throw "js/wheel.js 又出现了 prompt() —— 举报原因必须从白名单里选，手打必然 400" }
if ($wheelJs -notmatch 'report-reason\.js') { throw "js/wheel.js 未接入 js/report-reason.js" }
$reasonJs = Join-Path $stage "js/report-reason.js"
if (-not (Test-Path $reasonJs)) { throw "缺少 js/report-reason.js（举报原因弹层）" }
if ((Get-Content $reasonJs -Raw -Encoding UTF8) -notmatch 'REPORT_REASONS') { throw "js/report-reason.js 未使用服务端白名单 REPORT_REASONS" }

& tar -czf $tar -C $stage .
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ">> 已打包: $tar" -ForegroundColor Green
Write-Host ">> 服务器解压: sudo tar -xzf qtvq-static.tgz -C /var/www/qtvq && sudo chown -R www-data:www-data /var/www/qtvq"
