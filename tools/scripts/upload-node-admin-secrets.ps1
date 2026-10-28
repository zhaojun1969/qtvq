# 把 Node 服务（运营台）的 ADMIN_KEY 与 API 基址推给 Cloudflare Pages
# 用途：缘值充值「在线支付自动到账」——Pages 侧收到付款后要调用 Node 的
#      POST /v1/admin/users/:uid/credit 给钱包入账（幂等键用订单号）。
# Usage: powershell -ExecutionPolicy Bypass -File tools/scripts/upload-node-admin-secrets.ps1

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

if (-not (. (Join-Path $PSScriptRoot "load-cf-env.ps1"))) {
    Write-Host "WARN: cf.env 未加载，将使用 wrangler 登录缓存" -ForegroundColor Yellow
}
$Project = "qtvq-api"

# NODE_ADMIN_KEY 取自 server/.env 的 ADMIN_KEY（即运营台口令）
$envFile = Join-Path $Root "server/.env"
if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: 缺少 server/.env" -ForegroundColor Red
    exit 1
}
$lines = Get-Content $envFile -Encoding UTF8
$adminKey = ($lines | Where-Object { $_ -match '^ADMIN_KEY=' } | Select-Object -First 1) -replace '^ADMIN_KEY=', ''
$adminKey = "$adminKey".Trim()
if (-not $adminKey) {
    Write-Host "ERROR: server/.env 中缺少 ADMIN_KEY=" -ForegroundColor Red
    exit 1
}

$pairs = @{
    'NODE_ADMIN_KEY' = $adminKey
    'NODE_API_BASE'  = 'https://qtvq.cn'
}

foreach ($k in $pairs.Keys) {
    Write-Host ">> Upload $k ..."
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($tmp, $pairs[$k], [System.Text.UTF8Encoding]::new($false))
        cmd /c "npx wrangler pages secret put $k --project-name=$Project < `"$tmp`""
        if ($LASTEXITCODE -ne 0) { throw "wrangler exit $LASTEXITCODE" }
    } finally {
        Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ">> 已上传 NODE_ADMIN_KEY（长度 $($adminKey.Length)）与 NODE_API_BASE。密钥变更需重新部署：" -ForegroundColor Green
Write-Host "   node tools/scripts/deploy.ps1" -ForegroundColor Green
Write-Host ">> 验证：node tools/scripts/check-topup-chain.mjs" -ForegroundColor Green
