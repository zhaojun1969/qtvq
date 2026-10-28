# 「扫码买一份真实报告」本地入口
#
# 为什么要有这一层：真实支付必须有人拿手机扫一张二维码，而服务端脚本跑在服务器上
# （要读 secrets/ 下的商户私钥）。所以：
#   ① 远端建单 + 出码（--no-wait）→ 把二维码图 scp 回本地并打开
#   ② 远端阻塞等待支付（--wait）→ 支付成功后自动生成报告，并核对订单被消费
# 中间就是留给"你扫一下"的时间。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/scripts/buy-real-report.ps1 -Sku diagnose
#   ... -Sku retro -Timeout 900
#   ... -Resume rpt_xxxx            # 上次超时了？直接接着等这张单
#
# 提示：二维码有效期由微信控制（一般 2 小时）。超时未付不会扣钱，订单会留在库里，
#       重新跑 -Resume <orderId> 即可继续等。

param(
    [ValidateSet('diagnose', 'retro', 'pair')]
    [string]$Sku = 'diagnose',
    [string]$Resume = '',
    [int]$Timeout = 600,
    [string]$KeyFile = $(if ($env:QTVQ_SSH_KEY) { $env:QTVQ_SSH_KEY } else { "$env:USERPROFILE\.ssh\id_ed25519_yuan" }),
    [string]$SshHost = $(if ($env:QTVQ_SSH_HOST) { $env:QTVQ_SSH_HOST } else { "admin@47.115.214.130" }),
    [string]$AppDir = "/opt/qtvq/server",
    [string]$LocalQr = "",
    [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

function Fail($text) { Write-Host "✗ $text" -ForegroundColor Red; exit 1 }
function Step($text) { Write-Host "`n>> $text" -ForegroundColor Cyan }

if (-not $LocalQr) { $LocalQr = Join-Path $Root "dist\real-pay-qr.png" }
New-Item -ItemType Directory -Force -Path (Split-Path $LocalQr) | Out-Null

$RemoteQr = "/tmp/qtvq-real-pay-$([guid]::NewGuid().ToString('N').Substring(0,8)).png"
$orderId = $Resume

# ─────────────────────────── ① 建单 + 出码 ───────────────────────────
if (-not $orderId) {
    Step "建单并生成微信二维码（sku=$Sku）"
    # 远端要读 secrets/ 下的私钥，必须 root
    $out = & ssh -i $KeyFile -o BatchMode=yes $SshHost "cd $AppDir && sudo node --env-file=.env scripts/buy-real-report.mjs --sku=$Sku --qr-out=$RemoteQr --no-wait" 2>&1 | Out-String
    Write-Host $out
    $m = [regex]::Match($out, '订单：(rpt_[A-Za-z0-9_]+)')
    if (-not $m.Success) { Fail "没拿到 orderId，见上面的输出" }
    $orderId = $m.Groups[1].Value

    Step "取回二维码"
    & scp -i $KeyFile -o BatchMode=yes "${SshHost}:$RemoteQr" $LocalQr 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $LocalQr)) { Fail "scp 二维码失败" }
    & ssh -i $KeyFile -o BatchMode=yes $SshHost "sudo rm -f $RemoteQr" 2>&1 | Out-Null
    $png = Get-Item $LocalQr
    Write-Host "二维码已保存：$($png.FullName)（$([math]::Round($png.Length/1KB,1)) KB）" -ForegroundColor Green
    if (-not $NoOpen) { Start-Process $png.FullName; Write-Host "已用默认看图工具打开 —— 用手机扫码付款即可。" -ForegroundColor Gray }
}

Write-Host ""
Write-Host "订单：$orderId" -ForegroundColor Yellow
Write-Host "接下来会阻塞等待支付（最多 $Timeout 秒）。扫码付款后会自动生成报告；" -ForegroundColor Gray
Write-Host "如果超时，重跑：powershell -File tools/scripts/buy-real-report.ps1 -Resume $orderId" -ForegroundColor Gray

# ─────────────────────────── ② 等支付 + 生成报告 ───────────────────────────
Step "等待支付"
$out2 = & ssh -i $KeyFile -o BatchMode=yes $SshHost "cd $AppDir && sudo node --env-file=.env scripts/buy-real-report.mjs --order-id=$orderId --wait --timeout=$Timeout" 2>&1 | Out-String
Write-Host $out2

if ($LASTEXITCODE -eq 3 -or $out2 -match '超时未支付') {
    Write-Host ""
    Write-Host "⏳ 还没付款。订单已保留，付款后重跑：" -ForegroundColor Yellow
    Write-Host "   powershell -File tools/scripts/buy-real-report.ps1 -Resume $orderId" -ForegroundColor Yellow
    exit 3
}

if ($out2 -match '全链路通过') {
    Write-Host ""
    Write-Host "✅ 真实扫码支付 → 生成报告 → 订单消费，全链路通过" -ForegroundColor Green
    exit 0
}

Fail "未通过，见上面的输出"
