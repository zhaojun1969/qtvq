# 一键发布静态站：**同时**部署源站与 static 域名（Pages）
#
# 为什么需要这个脚本（2026-10-26）：
#   为了让源站 5 Mbps 带宽卸载，收款码等图片改由 `https://static.qtvq.cn`（Cloudflare Pages）提供，
#   而 HTML/CSS/JS 仍在源站 nginx。于是"发布静态站"变成了**两个地方都要发**：
#     · 源站   /var/www/qtvq          ← package-static.ps1 打 tgz → OSS → 服务器解包
#     · Pages  项目 qtvq-site          ← build-pages-public → wrangler pages deploy
#   只发一处 = 用户看到旧收款码。那不是"图片不新鲜"，是**钱可能付错人**。
#   在此之前这套流程靠人手敲 5 条命令，漏一步没人拦得住。现在合成一条命令，末尾自检。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/scripts/publish-static.ps1
#   powershell -ExecutionPolicy Bypass -File tools/scripts/publish-static.ps1 -SkipBuild     # 复用已打的包
#   powershell -ExecutionPolicy Bypass -File tools/scripts/publish-static.ps1 -OriginOnly
#   powershell -ExecutionPolicy Bypass -File tools/scripts/publish-static.ps1 -PagesOnly

param(
    [switch]$SkipBuild,
    [switch]$OriginOnly,
    [switch]$PagesOnly,
    # 默认值可被 cf.env 的 QTVQ_SSH_* 覆盖（与既有部署脚本保持同一套配置来源）
    [string]$KeyFile = $(if ($env:QTVQ_SSH_KEY) { $env:QTVQ_SSH_KEY } else { "$env:USERPROFILE\.ssh\id_ed25519_yuan" }),
    [string]$SshHost = $(if ($env:QTVQ_SSH_HOST) { $env:QTVQ_SSH_HOST } else { "admin@47.115.214.130" }),
    [string]$PagesProject = "qtvq-site"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

function Step($text) { Write-Host "`n>> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "✗ $text" -ForegroundColor Red; exit 1 }

$doOrigin = -not $PagesOnly
$doPages = -not $OriginOnly

# ─────────────────────────── 1. 构建 ───────────────────────────
if (-not $SkipBuild) {
    Step "打包静态站（package-static）"
    & powershell -ExecutionPolicy Bypass -File (Join-Path $Root "tools/scripts/package-static.ps1")
    if ($LASTEXITCODE -ne 0) { Fail "package-static 失败（exit $LASTEXITCODE）" }
}
$tgz = Join-Path $Root "dist/qtvq-static.tgz"
if ($doOrigin -and -not (Test-Path $tgz)) { Fail "缺少 $tgz（先不加 -SkipBuild 跑一次）" }

# ─────────────────────── 2. 源站：OSS → 服务器 ───────────────────────
if ($doOrigin) {
    Step "上传到 OSS"
    & python (Join-Path $Root "tools/scripts/upload-obs.py") $tgz
    if ($LASTEXITCODE -ne 0) { Fail "upload-obs 失败" }

    Step "生成 OSS 签名 URL"
    $signPy = Join-Path $env:TEMP "qtvq-sign-static.py"
    @'
import sys, pathlib
sys.path.insert(0, str(pathlib.Path("tools/scripts").resolve()))
from obs import ObsClient
env = {}
for line in pathlib.Path("obs.env").read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1); env[k.strip()] = v.strip().strip('"').strip("'")
c = ObsClient(access_key_id=env["OBS_ACCESS_KEY_ID"], secret_access_key=env["OBS_SECRET_ACCESS_KEY"],
              server=env.get("OBS_ENDPOINT", "oss-cn-beijing.aliyuncs.com"))
r = c.createSignedUrl("GET", env.get("OBS_BUCKET", "qtvq"), "qtvq/context/qtvq-static.tgz", expires=3600)
print(r.signedUrl.replace("AccessKeyId=", "OSSAccessKeyId="))
'@ | Set-Content -Path $signPy -Encoding UTF8
    $url = (& python $signPy 2>&1 | Select-Object -Last 1)
    Remove-Item $signPy -Force -ErrorAction SilentlyContinue
    if (-not $url -or $url -notmatch '^https://') { Fail "签名 URL 生成失败：$url" }

    Step "服务器解包到 /var/www/qtvq"
    $remote = @"
set -e
cd /tmp
curl -fSL --retry 3 --max-time 180 -o qtvq-static.tgz '$url' 2>/dev/null
sudo tar -xzf qtvq-static.tgz -C /var/www/qtvq 2>/dev/null
sudo chown -R www-data:www-data /var/www/qtvq
rm -f qtvq-static.tgz
echo '  源站已更新'
"@
    # ⚠️ 必须先把 CRLF 归一成 LF：这段脚本是 base64 后交给远端 bash 执行的，
    # 行尾带 \r 会让 `set -e` / `cd` / `tar -C` 全部报 "invalid option / No such file or directory"，
    # 而 `set -e` 本身失效后脚本会"看起来成功"——2026-10-26 实际踩到，源站并未更新却打印成功。
    $remote = ($remote -replace "`r`n", "`n")
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote))
    # 原生命令的 stderr 在 ErrorActionPreference=Stop 下会被当成异常抛出（ssh/tar 的
    # 进度与时钟偏差警告都走 stderr）。这里临时放宽，只以退出码为准。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $out = & ssh -i $KeyFile -o BatchMode=yes -o ConnectTimeout=30 $SshHost "echo $b64 | base64 -d | sudo bash" 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($code -ne 0) { Write-Host $out; Fail "服务器解包失败（ssh 退出码 $code）" }
    Write-Host $out.Trim() -ForegroundColor DarkGray
}

# ───────────────────── 3. static 域名：Pages 部署 ─────────────────────
if ($doPages) {
    Step "构建白名单发布目录"
    & powershell -ExecutionPolicy Bypass -File (Join-Path $Root "tools/scripts/build-pages-public.ps1")
    if ($LASTEXITCODE -ne 0) { Fail "build-pages-public 失败" }

    # 只发静态资产：把 functions 排除掉。
    # 否则 API 也会出现在 static.qtvq.cn 上，多一份无意义的对外接口面。
    Step "准备纯静态目录（排除 functions）"
    $src = Join-Path $Root "dist/pages-public"
    $dst = Join-Path $Root "dist/site-static"
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Get-ChildItem $src -Force | Where-Object { $_.Name -ne "functions" } | ForEach-Object {
        Copy-Item $_.FullName -Destination $dst -Recurse -Force
    }
    if (Test-Path (Join-Path $dst "functions")) { Fail "functions 未被排除，拒绝部署" }

    Step "wrangler pages deploy → $PagesProject"
    $env:CLOUDFLARE_API_TOKEN = ((Get-Content (Join-Path $Root "cf.env") -Encoding UTF8 |
        Where-Object { $_ -match '^\s*CLOUDFLARE_API_TOKEN\s*=' }) -replace '^\s*CLOUDFLARE_API_TOKEN\s*=\s*', '').Trim().Trim('"')
    if (-not $env:CLOUDFLARE_API_TOKEN) { Fail "cf.env 里没有 CLOUDFLARE_API_TOKEN" }
    $wout = & npx wrangler pages deploy $dst --project-name=$PagesProject --branch=main --commit-dirty=true 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { Write-Host $wout; Fail "wrangler 部署失败" }
    ($wout -split "`n" | Where-Object { $_ -match 'Success|Uploaded|Deployment' } | Select-Object -First 3) |
        ForEach-Object { Write-Host ("  " + $_.Trim()) -ForegroundColor DarkGray }
}

# ─────────────────────────── 4. 自检 ───────────────────────────
Step "自检：源站与 static 域名是否一致"
& node (Join-Path $Root "tools/scripts/check-static-domain-sync.mjs")
if ($LASTEXITCODE -ne 0) {
    Fail "自检失败：源站与 static 域名内容不一致（用户会拿到旧收款码）。请重跑本脚本，不要只发一处。"
}

Step "自检：线上关键路径"
$targets = @(
    "https://qtvq.cn/",
    "https://static.qtvq.cn/assets/payment/qr-wechat.webp"
)
$bad = 0
foreach ($u in $targets) {
    $code = & curl.exe -4 -sS --ssl-no-revoke -o NUL -w "%{http_code}" --max-time 20 $u 2>$null
    if ($code -ne "200") { Write-Host ("  ✗ " + $u + " → " + $code) -ForegroundColor Red; $bad++ }
    else { Write-Host ("  ✓ " + $u) -ForegroundColor Green }
}
if ($bad -gt 0) { Fail "$bad 个关键路径不可用" }

Write-Host "`n✅ 发布完成：源站 + $PagesProject 均已更新并通过一致性自检" -ForegroundColor Green
