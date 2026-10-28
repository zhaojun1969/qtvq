param(
    [Parameter(Mandatory = $true)][string]$Stage
)

# 静态资源指纹注入 —— **唯一实现**
#
# 2026-10-28 抽出本文件的直接原因：
# 指纹注入原来只写在 `package-static.ps1`（打 ZIP 用）里，而线上真正在跑的是
# `sync-static-from-windows.ps1`（scp 到阿里云源站）—— 那条通道**完全没走这段**。
# 结果线上首页从来没有 `?v=`，`check-cache-policy.mjs` 判红：
# "首页 HTML 里没有找到 ?v=<hash> 版本指纹 —— 少了指纹就不能安全长缓存"。
#
# 教训：**同一件事有两份实现，就一定会有一份漏掉**。所以这里只留一份，
# 两条通道都调它。以后新增第三条部署通道，也必须调它。
#
# 指纹算法（沿用原实现，别改）：把 css/ 与 js/ 下**所有**文件内容哈希排序后拼起来再哈希，
# 取前 8 位。
# 为什么不是只哈希 styles.css：只改 JS 时 styles.css 不变 → URL 不变 → 浏览器继续用
# 缓存里的旧 JS，修复看起来像没生效（2026-10-11 实际踩到过）。

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Stage)) {
    Write-Host "ERROR: 目录不存在：$Stage" -ForegroundColor Red
    exit 1
}

$cssFiles = @(Get-ChildItem (Join-Path $Stage 'css') -Recurse -File -Filter *.css -ErrorAction SilentlyContinue)
$jsFiles = @(Get-ChildItem (Join-Path $Stage 'js') -Recurse -File -Filter *.js -ErrorAction SilentlyContinue)
$assetFiles = @($cssFiles) + @($jsFiles)

if ($assetFiles.Count -eq 0) {
    Write-Host "ERROR: $Stage 下没有 css/js，无法计算指纹（目录传错了？）" -ForegroundColor Red
    exit 1
}

$joined = ($assetFiles | Sort-Object FullName | ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA256).Hash }) -join ''
$sha = [System.Security.Cryptography.SHA256]::Create()
$assetVer = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($joined)))).Replace('-', '').Substring(0, 8).ToLower()
$sha.Dispose()

$touched = 0
Get-ChildItem $Stage -File -Filter '*.html' | ForEach-Object {
    $p = $_.FullName
    $h = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
    $orig = $h
    $h = $h -replace '(href="css/([^"?]+)\.css)(\?v=[0-9a-f]+)?"', ('$1?v=' + $assetVer + '"')
    $h = $h -replace '(src="(?:\./)?js/([^"?]+)\.js)(\?v=[0-9a-f]+)?"', ('$1?v=' + $assetVer + '"')
    if ($h -ne $orig) {
        [IO.File]::WriteAllText($p, $h, (New-Object System.Text.UTF8Encoding($false)))
        $touched += 1
    }
}

# 注意：这里**不能**用 Write-Host 打日志。调用方是 `$ver = & script.ps1`，
# 而 `powershell -File` 的 stdout 会连同 Write-Host 一起进管道 ——
# 实测拿到的是两行拼接（">> 静态资源版本号: 1049f582（改写了 2 个页面） 1049f582"），
# 后续任何版本号比较都会错。日志交给调用方打印。
return $assetVer
