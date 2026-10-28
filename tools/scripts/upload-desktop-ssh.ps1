# 上传桌面客户端安装包到服务器（供 https://qtvq.cn/release/desktop/ 下载与自动更新）
#
# 为什么走 SSH 而不是 OSS：OSS 桶是**私有的**（匿名请求 403，已验证），
# 不能直接当公开下载源；而 Electron 的自动更新只需要"一个能直接下载文件的 URL"。
# 放到自家已备案域名下的目录，最省事、最可信，也不必再维护一套签名下载。
#
# 用法:
#   pwsh tools/scripts/upload-desktop-ssh.ps1            # 上传 dist/desktop-release 下的全部文件
#   pwsh tools/scripts/upload-desktop-ssh.ps1 -SkipVerify
#
# 前置：先跑 node tools/scripts/publish-desktop-release.mjs 生成 dist/desktop-release
#
# 实测可用的凭据（2026-09-20）：admin@47.115.214.130 + ~/.ssh/id_ed25519_yuan，sudo 免密。

param(
    [string]$SshHost = $env:QTVQ_SSH_HOST,
    [string]$User = "admin",
    [string]$KeyFile = "$env:USERPROFILE\.ssh\id_ed25519_yuan",
    [string]$RemoteDir = "/var/www/qtvq/release/desktop",
    [string]$PublicBase = "https://qtvq.cn/release/desktop",
    [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

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

$stage = Join-Path $Root "dist\desktop-release"
if (-not (Test-Path $stage)) {
    Write-Host "ERROR: 找不到 $stage" -ForegroundColor Red
    Write-Host "  先运行：node tools/scripts/publish-desktop-release.mjs" -ForegroundColor Yellow
    exit 1
}

$files = Get-ChildItem $stage -File | Where-Object { $_.Name -match '\.(exe|yml|blockmap)$' }
if ($files.Count -eq 0) { Write-Host "ERROR: 目录里没有可发布的文件（.exe/.yml/.blockmap）" -ForegroundColor Red; exit 1 }

$hasYml = $files | Where-Object { $_.Name -eq 'latest.yml' }
if (-not $hasYml) {
    Write-Host "ERROR: 缺少 latest.yml —— 没有它客户端的自动更新无法工作（不是可选项）" -ForegroundColor Red
    exit 1
}

Write-Host "=== 上传桌面客户端到 $User@$SshHost : $RemoteDir ===" -ForegroundColor Cyan
$target = "$User@$SshHost"
$sshArgs = @("-i", $KeyFile, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new")

# 目录归 root，必须 sudo 创建；已存在则忽略错误
# 注意 $ErrorActionPreference='Stop' 下原生命令的 stderr 会被当成终止性错误，
# 所以这里显式把偏好设回 Continue（这个坑在 deploy-server-ssh.ps1 里踩过一次）。
$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& ssh @sshArgs $target "sudo mkdir -p $RemoteDir && sudo chown -R www-data:www-data /var/www/qtvq/release" 2>&1 | Out-Null
$ErrorActionPreference = $prev

$uploaded = 0
foreach ($f in $files) {
    $mb = [math]::Round($f.Length / 1MB, 2)
    Write-Host ">> 上传 $($f.Name)（$mb MB）..."
    # scp 到 /tmp（用户可写），再用 sudo 移到目标目录（root 所有）
    & scp @sshArgs $f.FullName "${target}:/tmp/$($f.Name)"
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: scp 失败: $($f.Name)" -ForegroundColor Red; exit 1 }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & ssh @sshArgs $target "sudo mv -f '/tmp/$($f.Name)' '$RemoteDir/$($f.Name)' && sudo chown www-data:www-data '$RemoteDir/$($f.Name)'" 2>&1 | Out-Null
    $ErrorActionPreference = $prev
    $uploaded++
}

Write-Host ""
Write-Host "✅ 已上传 $uploaded 个文件" -ForegroundColor Green

if ($SkipVerify) { exit 0 }

# 落地核验：**从公网读回来**（不只看 scp 成功）。
# 这一步是必需的：nginx 目录权限、防盗链、缓存都可能让"传上去了"变成"下不下来"。
Write-Host ""
Write-Host "=== 公网核验（实际下载 latest.yml 并比对内容）===" -ForegroundColor Cyan
$ok = 0
$bad = 0
foreach ($f in $files) {
    $url = "$PublicBase/$($f.Name)"
    try {
        $resp = Invoke-WebRequest -Uri $url -Method Head -TimeoutSec 30 -UseBasicParsing
        $len = $resp.Headers['Content-Length']
        if ($len -and [int64]$len -eq $f.Length) {
            Write-Host "  ✅ $($f.Name)  HTTP $($resp.StatusCode)  $len 字节（与本地一致）" -ForegroundColor Green
            $ok++
        } else {
            Write-Host "  ⚠️  $($f.Name)  HTTP $($resp.StatusCode)  长度 $len ≠ 本地 $($f.Length)" -ForegroundColor Yellow
            $bad++
        }
    } catch {
        Write-Host "  ❌ $($f.Name)  取不到：$($_.Exception.Message)" -ForegroundColor Red
        $bad++
    }
}

# ── latest.yml 的"内部一致性"必须单独核（2026-10-28 加）────────────────────
# 上面那段只证明"每个文件都能下载、大小对得上"，**证明不了 latest.yml 能用**。
# 线上真实状况（本次审计发现）：latest.yml 里写的是 `Q问-Setup-1.0.6.exe`（公网 404），
# 真正传上去的却是 `qtvq-desktop-Setup-1.0.6.exe`（200）。也就是：
#   客户端读清单 → 拿到 404 的下载地址 → 自动更新**每次都失败**；
#   而下载页手动下载是好的（页面用的是另一份配置）。
# 于是"手动能下、自动更新不行"，用户只会说"它不提示更新"，很难联想到清单里是旧文件名。
# 这个坑的成因是：打包产物里 latest.yml 与 exe 是**同一批**，但某次只覆盖了 exe、
# 没覆盖 latest.yml（或者反过来）。所以只有"清单里引用的文件真能下"才算数。
$ymlFile = $files | Where-Object { $_.Name -eq 'latest.yml' } | Select-Object -First 1
if ($ymlFile) {
    Write-Host "  · 校验 latest.yml 引用的安装包是否真的存在…" -ForegroundColor DarkGray
    $ymlText = Get-Content $ymlFile.FullName -Raw -Encoding UTF8
    $refMatch = [regex]::Match($ymlText, 'url:\s*(\S+)')
    $sizeMatch = [regex]::Match($ymlText, 'size:\s*(\d+)')
    if (-not $refMatch.Success) {
        Write-Host "  ❌ latest.yml 里没有 url 字段（electron-updater 无法定位安装包）" -ForegroundColor Red
        $bad++
    } else {
        $refName = $refMatch.Groups[1].Value.Trim()
        $refUrl = "$PublicBase/$refName"
        try {
            $refResp = Invoke-WebRequest -Uri $refUrl -Method Head -TimeoutSec 30 -UseBasicParsing
            $refLen = $refResp.Headers['Content-Length']
            if ($sizeMatch.Success -and $refLen -and [int64]$refLen -ne [int64]$sizeMatch.Groups[1].Value) {
                Write-Host "  ❌ latest.yml 指向 $refName 可下载，但长度 $refLen ≠ 清单写的 $($sizeMatch.Groups[1].Value)（客户端 sha512 校验会失败）" -ForegroundColor Red
                $bad++
            } else {
                Write-Host "  ✅ latest.yml 指向的 $refName 可公网下载（$refLen 字节）" -ForegroundColor Green
            }
        } catch {
            Write-Host "  ❌ latest.yml 指向 $refName —— 公网取不到（$($_.Exception.Message)）" -ForegroundColor Red
            Write-Host "     客户端自动更新会一直失败，而下载页却是好的：这类「手动能下、自动更新不行」最难排查。" -ForegroundColor DarkYellow
            $bad++
        }
    }
}

Write-Host ""
if ($bad -eq 0) {
    Write-Host "✅ 全部 $ok 个文件可公网下载（客户端自动更新的前提已满足）" -ForegroundColor Green
    exit 0
}
Write-Host "❌ 有 $bad 个文件核验不通过。检查：nginx 是否允许该目录、文件权限是否 www-data、是否有防盗链。" -ForegroundColor Red
exit 1
