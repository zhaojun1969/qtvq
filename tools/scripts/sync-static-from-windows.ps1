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

$items = @(
    "index.html", "account.html", "wechat-callback.html", "pitfalls.html", "profile.html", "help.html", "privacy.html", "download.html", "404.html",
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
$remoteCmd = "set -e; sudo mkdir -p '$Dest'; sudo tar -xzf /tmp/qtvq-static.tgz -C '$Dest'; sudo chown -R www-data:www-data '$Dest'; rm -f /tmp/qtvq-static.tgz; test -f '$Dest/js/config.js'; test -f '$Dest/js/contact.js'; test -f '$Dest/js/toast.js'; test -f '$Dest/js/voice-asr.js'; test -f '$Dest/js/version.js'; grep -q BUILD_SHA '$Dest/js/version.js'; grep -q feature-card-link '$Dest/index.html'; grep -q story-card-clickable '$Dest/js/home.js'; grep -q voice-asr '$Dest/js/home.js'; grep -q initContactModal '$Dest/js/layout.js'; echo OK"
$sshArgs += @($target, $remoteCmd)

Write-Host ">> Extract on server at $Dest"
& ssh @sshArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $tar -Force -ErrorAction SilentlyContinue
Write-Host ">> Static OK: https://qtvq.cn/" -ForegroundColor Green
