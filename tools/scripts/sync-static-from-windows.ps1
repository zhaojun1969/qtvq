# Sync static files from Windows to Aliyun Nginx (no functions)
# Requires SSH key or password; set QTVQ_SSH_* in cf.env
#
# 2026-10-28 修了两个会让这条命令"看起来在跑、其实永远不结束"的问题：
#
#   ① 默认账号取 `$env:QTVQ_SSH_USER`，而 cf.env 里写的是 `root`；
#      密钥 `id_ed25519` 只被 `admin` 授权 → ssh 落到密码提示，
#      在非交互环境里就静默挂住（实测挂了 15 分钟，一个字符都没输出）。
#      现在默认与 `deploy-server-ssh.ps1` 对齐成 `admin`：那是仓库里实测可用、
#      且 sudo 免密的账号。cf.env 的 QTVQ_SSH_USER 仅作参考，不再当默认值。
#   ② scp/ssh 都没带 BatchMode → 密钥不对时不是报错，而是等一个不会来的密码。
#      加上 `-o BatchMode=yes -o ConnectTimeout=15` 之后，同样的错 1 秒内就红。
#
# 结论性的教训：**部署脚本最坏的失败方式不是报错，是没反应**。

param(
    [string]$SshHost = $env:QTVQ_SSH_HOST,
    [string]$User = "admin",
    [string]$Dest = $env:QTVQ_STATIC_DEST,
    [string]$KeyFile = "$env:USERPROFILE\.ssh\id_ed25519_yuan"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

. (Join-Path $PSScriptRoot "load-cf-env.ps1") | Out-Null
if (-not $SshHost) { $SshHost = $env:QTVQ_SSH_HOST }
if (-not $User) { $User = $env:QTVQ_SSH_USER }
if (-not $Dest) { $Dest = $env:QTVQ_STATIC_DEST }

if (-not $SshHost -or -not $User -or -not $Dest) {
    Write-Host "ERROR: Set QTVQ_SSH_HOST / QTVQ_SSH_USER / QTVQ_STATIC_DEST in cf.env" -ForegroundColor Red
    exit 1
}

& (Join-Path $PSScriptRoot "write-version.ps1")

$stage = Join-Path $env:TEMP "qtvq-static-$(Get-Date -Format 'yyyyMMddHHmmss')"
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# 根目录页面用通配符自动纳入，而不是手写清单。
#
# 2026-10-28（E.40）实际发现的状况：这里原本手写着 11 个页面，
# 而 `advice.html` / `land.html` / `r.html` 三个 P2/P3 新增页面**不在清单里** ——
# 走这条通道部署时它们永远不会更新，页面改半天"怎么没生效"。
# `package-static.ps1` 在 E.38 已经踩过同一个坑（漏了 account.html 与 wechat-callback.html），
# 但那次只修了一处。现在两处都改成"枚举全部 *.html"，从结构上消除漏页的可能。
$htmlPages = Get-ChildItem -Path $Root -File -Filter "*.html" | ForEach-Object { $_.Name }
Write-Host ">> 根目录页面 $($htmlPages.Count) 个：$($htmlPages -join ', ')"

$items = @($htmlPages) + @(
    "css", "js", "assets",
    "robots.txt", "sitemap.xml", "_headers", "_redirects"
)
foreach ($item in $items) {
    if (Test-Path $item) { Copy-Item $item (Join-Path $stage $item) -Recurse -Force }
}

& (Join-Path $PSScriptRoot "copy-verify-root.ps1") -Stage $stage -Root $Root

# 静态资源指纹：这条通道（scp 到阿里云源站）是**线上真正在用的**，缺了它就没有 `?v=`。
# 2026-10-28 之前确实缺 —— 指纹只写进了 package-static.ps1（打 ZIP 用），
# check-cache-policy 因此长期判红：线上 CSS/JS 无法长缓存，改了还得让用户 Ctrl+F5。
$assetVer = & (Join-Path $PSScriptRoot "inject-asset-version.ps1") -Stage $stage
if (-not $assetVer) {
    Write-Host "ERROR: 静态资源指纹注入失败（inject-asset-version.ps1 没有返回版本号）" -ForegroundColor Red
    exit 1
}
Write-Host ">> 静态资源版本号: $assetVer" -ForegroundColor DarkGray

$tar = Join-Path $env:TEMP "qtvq-static.tgz"
if (Test-Path $tar) { Remove-Item $tar -Force }
& tar -czf $tar -C $stage . 2>$null
# tar 会把"时间戳在未来"这类时钟偏差警告写到 stderr，而 Windows PowerShell 5.1 在
# $ErrorActionPreference='Stop' 下**把原生命令的 stderr 当成异常**：
# 结果包已经打好、文件也传完、日志还打印了 "Static OK"，退出码却是 1。
# 所以这里只看退出码，stderr 丢掉（真有错误时退出码会非 0）。
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: 打包失败（tar exit $LASTEXITCODE）：$tar" -ForegroundColor Red
    exit 1
}

$target = "${User}@${SshHost}"
$scpArgs = @()
if (Test-Path $KeyFile) { $scpArgs += @("-i", $KeyFile) }
# BatchMode：密钥不对时立刻失败，而不是等一个永远不会来的密码提示
$scpArgs += @("-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new")
$scpArgs += @($tar, "${target}:/tmp/qtvq-static.tgz")

Write-Host ">> SCP static bundle to $target"
& scp @scpArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "SSH failed. 常见原因：" -ForegroundColor Yellow
    Write-Host "  · 密钥没被该账号授权：换成 -User admin -KeyFile `$env:USERPROFILE\.ssh\id_ed25519_yuan"
    Write-Host "  · 服务器未放行本机 IP"
    Write-Host "  · 或者干脆在服务器上：cd /opt/qtvq; git pull; bash tools/scripts/sync-static.sh"
    exit 1
}

$sshArgs = @()
if (Test-Path $KeyFile) { $sshArgs += @("-i", $KeyFile) }
$sshArgs += @("-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new")
$remoteCmd = "set -e; sudo mkdir -p '$Dest'; sudo tar -xzf /tmp/qtvq-static.tgz -C '$Dest'; sudo chown -R www-data:www-data '$Dest'; rm -f /tmp/qtvq-static.tgz; test -f '$Dest/js/config.js'; test -f '$Dest/js/contact.js'; test -f '$Dest/js/toast.js'; test -f '$Dest/js/voice-asr.js'; test -f '$Dest/js/version.js'; test -f '$Dest/report.html'; test -f '$Dest/js/report.js'; test -f '$Dest/js/report-api.js'; test -f '$Dest/js/report-share.js'; test -f '$Dest/css/report.css'; test -f '$Dest/wheel.html'; test -f '$Dest/js/wheel.js'; test -f '$Dest/css/wheel.css'; grep -q BUILD_SHA '$Dest/js/version.js'; grep -q BUILD_SIG '$Dest/js/version.js'; grep -q feature-card-link '$Dest/index.html'; grep -q story-card-clickable '$Dest/js/home.js'; grep -q voice-asr '$Dest/js/home.js'; grep -q initContactModal '$Dest/js/layout.js'; grep -q 'js/report.js' '$Dest/report.html'; grep -q 'report.html' '$Dest/index.html'; grep -q 'wheel.html' '$Dest/index.html'; grep -q 'wheel-canvas' '$Dest/wheel.html'; grep -qE 'css/[a-z-]+\.css\?v=[0-9a-f]{6,}' '$Dest/index.html'; echo OK"
$sshArgs += @($target, $remoteCmd)

Write-Host ">> Extract on server at $Dest"
# 远端 tar 解包也会对"时间戳在未来"（宿主机时钟快约 11 秒）打警告，
# 警告随 ssh 的 stderr 回来。在 ErrorActionPreference=Stop 下，stderr 的第一行
# 会被**直接当成终止错误抛出** —— 连 `2>$null` 都来不及生效（实测仍然 EXIT=1）。
# 所以这里临时降到 Continue，判定只看退出码：远端命令末尾有 `test -f ... && echo OK`，
# 真失败必然非 0。
$eap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& ssh @sshArgs
$sshCode = $LASTEXITCODE
$ErrorActionPreference = $eap
if ($sshCode -ne 0) { exit $sshCode }

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $tar -Force -ErrorAction SilentlyContinue
Write-Host ">> Static OK: https://qtvq.cn/" -ForegroundColor Green
