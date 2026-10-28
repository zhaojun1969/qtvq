# Sync static files from Windows to Aliyun Nginx (no functions)
# Requires SSH key or password; set QTVQ_SSH_* in cf.env

param(
    [string]$SshHost = $env:QTVQ_SSH_HOST,
    [string]$User = $env:QTVQ_SSH_USER,
    [string]$Dest = $env:QTVQ_STATIC_DEST,
    [string]$KeyFile = "$env:USERPROFILE\.ssh\id_ed25519"
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

$tar = Join-Path $env:TEMP "qtvq-static.tgz"
if (Test-Path $tar) { Remove-Item $tar -Force }
& tar -czf $tar -C $stage .

$target = "${User}@${SshHost}"
$scpArgs = @()
if (Test-Path $KeyFile) { $scpArgs += @("-i", $KeyFile) }
$scpArgs += @($tar, "${target}:/tmp/qtvq-static.tgz")

Write-Host ">> SCP static bundle to $target"
& scp @scpArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "SSH failed. Add your public key to server authorized_keys:" -ForegroundColor Yellow
    Write-Host "  type $env:USERPROFILE\.ssh\id_ed25519.pub"
    Write-Host "Or on server: cd /opt/qtvq; git pull; bash tools/scripts/sync-static.sh"
    exit 1
}

$sshArgs = @()
if (Test-Path $KeyFile) { $sshArgs += @("-i", $KeyFile) }
$remoteCmd = "set -e; sudo mkdir -p '$Dest'; sudo tar -xzf /tmp/qtvq-static.tgz -C '$Dest'; sudo chown -R www-data:www-data '$Dest'; rm -f /tmp/qtvq-static.tgz; test -f '$Dest/js/config.js'; test -f '$Dest/js/contact.js'; test -f '$Dest/js/toast.js'; test -f '$Dest/js/voice-asr.js'; test -f '$Dest/js/version.js'; test -f '$Dest/report.html'; test -f '$Dest/js/report.js'; test -f '$Dest/js/report-api.js'; test -f '$Dest/js/report-share.js'; test -f '$Dest/css/report.css'; test -f '$Dest/wheel.html'; test -f '$Dest/js/wheel.js'; test -f '$Dest/css/wheel.css'; grep -q BUILD_SHA '$Dest/js/version.js'; grep -q BUILD_SIG '$Dest/js/version.js'; grep -q feature-card-link '$Dest/index.html'; grep -q story-card-clickable '$Dest/js/home.js'; grep -q voice-asr '$Dest/js/home.js'; grep -q initContactModal '$Dest/js/layout.js'; grep -q 'js/report.js' '$Dest/report.html'; grep -q 'report.html' '$Dest/index.html'; grep -q 'wheel.html' '$Dest/index.html'; grep -q 'wheel-canvas' '$Dest/wheel.html'; echo OK"
$sshArgs += @($target, $remoteCmd)

Write-Host ">> Extract on server at $Dest"
& ssh @sshArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $tar -Force -ErrorAction SilentlyContinue
Write-Host ">> Static OK: https://qtvq.cn/" -ForegroundColor Green
