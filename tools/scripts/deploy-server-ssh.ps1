# 一键：打包 server → 上传 OSS → 经 SSH 部署到 ECS → 自证指纹
#
# 为什么要有这个脚本（2026-09-20 连续两次部署没生效之后写的）：
#   ① 原来交付的是**多行** bash 命令，在 Windows 终端里容易被部分粘贴 —— 只下载、没解压，
#      而"下载成功"的输出让人以为做完了；
#   ② 命令被粘进 **Windows PowerShell**（不是服务器）：PowerShell 5.1 不支持 `&&`，
#      整条直接解析失败，一条都没执行；
#   ③ 交付的 URL 里带 `&`，经 PowerShell → ssh → bash 多层引号传递时容易被拆坏
#      （实测 curl 报 `(3) URL rejected`）。
# 现在的做法把这三件事一次性解决：命令在**服务器上用 base64 还原后执行**（不经过任何引号层），
# 且部署完**自己回读指纹**并与本地比对，把"部署成功"变成脚本给出的结论而不是人的判断。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File tools/scripts/deploy-server-ssh.ps1
#   ... -SkipUpload      # 复用上次上传的包（URL 需仍有效）
#   ... -User root -KeyFile C:\path\id_rsa
#
# 实测可用的凭据（2026-09-20）：用户 admin@47.115.214.130 + 密钥 ~/.ssh/id_ed25519_yuan，
# 且 sudo 免密（admin 不是 root，/opt/qtvq 归 root，所以解压与重启必须带 sudo）。

param(
    [string]$SshHost = $env:QTVQ_SSH_HOST,
    [string]$User = "admin",
    [string]$KeyFile = "$env:USERPROFILE\.ssh\id_ed25519_yuan",
    [string]$Url = "",
    [switch]$SkipUpload
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

# ---------------------------------------------------------------- 前置检查
# 读 cf.env 拿服务器地址（与 sync-static-from-windows.ps1 同一套配置）
if (-not $SshHost) {
    $cf = Join-Path $Root "cf.env"
    if (Test-Path $cf) {
        foreach ($line in (Get-Content $cf -Encoding UTF8)) {
            if ($line -match '^\s*QTVQ_SSH_HOST\s*=\s*(.+)$') { $SshHost = $Matches[1].Trim() }
        }
    }
}
if (-not $SshHost) { Write-Host "ERROR: 缺少服务器地址（cf.env 的 QTVQ_SSH_HOST 或 -SshHost）" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $KeyFile)) { Write-Host "ERROR: 找不到密钥 $KeyFile" -ForegroundColor Red; exit 1 }

$target = "$User@$SshHost"
Write-Host "=== 目标：$target（密钥 $([System.IO.Path]::GetFileName($KeyFile))）===" -ForegroundColor Cyan

$sshBase = @("-i", $KeyFile, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new", $target)

Write-Host ">> 测试 SSH 与 sudo ..."
$probe = & ssh @sshBase "sudo -n true && echo SUDO_OK || echo SUDO_NEEDS_PASSWORD" 2>&1 | Out-String
if ($probe -notmatch 'SUDO_OK') {
    Write-Host "ERROR: SSH 或 sudo 不可用。输出：$probe" -ForegroundColor Red
    Write-Host "   · Permission denied → 换 -User / -KeyFile" -ForegroundColor Yellow
    Write-Host "   · SUDO_NEEDS_PASSWORD → 需要密码的 sudo，无法非交互部署" -ForegroundColor Yellow
    exit 1
}
Write-Host "   SSH + sudo 免密 OK" -ForegroundColor Green

# ---------------------------------------------------------------- 打包上传
$fingerprint = ""
if ($SkipUpload -and $Url) {
    Write-Host ">> 跳过上传，复用给定 URL"
} else {
    Write-Host ">> 打包并上传（upload-server-bundle.py）..."
    $bundleOut = & python tools/scripts/upload-server-bundle.py 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { Write-Host $bundleOut; Write-Host "ERROR: 打包/上传失败" -ForegroundColor Red; exit 1 }
    # 不要用 `^...$` 锚定：Out-String 捕获的行尾是 \r\n，而 `[^\s]+` 会在 \r 前就停住，
    # 于是 `$` 永远匹配不上 —— 明明 URL 就在输出里，却报"没解析出签名 URL"。
    # （"检查器自己写错 → 假失败"这个坑本项目已踩过多次，所以这里只用不带锚点的匹配。）
    $m = [regex]::Match($bundleOut, '(https://qtvq\.oss-[^\s]+)')
    if (-not $m.Success) { Write-Host "ERROR: 没能从输出里解析出签名 URL" -ForegroundColor Red; Write-Host $bundleOut; exit 1 }
    $Url = $m.Groups[1].Value
    $fpMatch = [regex]::Match($bundleOut, '本次代码指纹（server/src，(\d+) 个文件）：([a-f0-9]+)')
    if ($fpMatch.Success) { $fingerprint = $fpMatch.Groups[2].Value }
}

# 本地指纹（与服务器 build-info.js 同算法，Python 与 Node 两处实现已互验）
$localFp = (& node tools/scripts/server-build-sha.mjs 2>&1 | Out-String)
$lm = [regex]::Match($localFp, '([a-f0-9]{16})')
$localSha = if ($lm.Success) { $lm.Groups[1].Value } else { "" }
if (-not $fingerprint) { $fingerprint = $localSha }
Write-Host ">> 本地指纹：$localSha"

# ---------------------------------------------------------------- 部署
# 远程脚本走 base64：**不经过 PowerShell/ssh 的引号层**。
# 实测：直接把带 & 的 URL 当一个参数传，curl 会报 `(3) URL rejected`
# （多层引号被剥/被拆），base64 之后只剩 [A-Za-z0-9+/=]，不可能被拆坏。
$remote = @"
set -e
cd /opt/qtvq
curl -fsSL -o /tmp/qtvq-server.tgz '$Url'
head -c 2 /tmp/qtvq-server.tgz | od -An -tx1 | grep -q 1f
sudo tar -xzf /tmp/qtvq-server.tgz -C /opt/qtvq
rm -f /tmp/qtvq-server.tgz
sudo systemctl restart qtvq-report
sleep 3
systemctl is-active qtvq-report
echo "metrics-timer=`$(systemctl is-active qtvq-metrics.timer)"
curl -sS http://127.0.0.1:3000/v1/health | head -c 600
"@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote))

Write-Host ">> 部署中（下载 → 解压 → 重启 → 自检）..."
# 必须临时把 Stop 关掉：ssh/curl 会把进度与告警写到 stderr，而 PS 5.1 在
# $ErrorActionPreference='Stop' 下会把**原生命令的 stderr** 当成终止性错误
# （NativeCommandError）直接中断脚本 —— 这个脚本第一版就是这么失败的。
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$out = & ssh @sshBase "echo $b64 | base64 -d | bash" 2>&1 | Out-String
$ErrorActionPreference = $prevEap
$active = $out -match '(?m)^active\s*$'
$timerMatch = [regex]::Match($out, 'metrics-timer=(\w+)')
$metricsTimer = if ($timerMatch.Success) { $timerMatch.Groups[1].Value } else { '' }
$shaMatch = [regex]::Match($out, '"sha":"([a-f0-9]+)"')
$remoteSha = if ($shaMatch.Success) { $shaMatch.Groups[1].Value } else { "" }

Write-Host ""
Write-Host "=== 结果 ===" -ForegroundColor Cyan
Write-Host "  服务状态     : $(if ($active) { 'active ✅' } else { '未确认 ❌' })"
Write-Host "  指标定时器   : $(if ($metricsTimer -eq 'active') { 'active ✅' } else { "未启用 ❌（daily 聚合不会自己跑，P4 验收门会一直是 insufficient）：sudo systemctl enable --now qtvq-metrics.timer" })"
Write-Host "  线上代码指纹 : $(if ($remoteSha) { $remoteSha } else { '(读取失败)' })"
Write-Host "  本地代码指纹 : $localSha"

if ($remoteSha -and $remoteSha -eq $localSha) {
    Write-Host ""
    Write-Host "✅ 部署成功：线上跑的就是本地这份代码" -ForegroundColor Green

    # E.88：部署后 POST+GET 双面冒烟——E.86 事故（POST 路由崩循环、/v1/health 依旧绿）
    # 的对策。冒烟失败 = 禁止放行（exit 1），运维立刻回滚或修复。
    Write-Host "=== 部署冒烟（GET+POST 双面）===" -ForegroundColor Cyan
    & node (Join-Path $Root "tools\scripts\deploy-smoke.mjs")
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ 冒烟未过：本次部署禁止放行——回滚或修复后重试。" -ForegroundColor Red
        exit 1
    }
    Write-Host "   下一步可跑：node tools/scripts/server-build-sha.mjs --check   # 从外网复核" -ForegroundColor Gray
    exit 0
}

Write-Host ""
Write-Host "❌ 未通过：指纹不一致或服务未起来。最近 40 行输出供排查：" -ForegroundColor Red
Write-Host ($out -split "`n" | Select-Object -Last 40 | Out-String)
exit 1
