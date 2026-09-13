# KV setup (if needed) + Pages deploy
# Usage: powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 [-SkipKv]

param(
    [switch]$SkipKv,
    [string]$ProjectName = "qtvq-api"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

. (Join-Path $PSScriptRoot "load-cf-env.ps1") | Out-Null
if (-not $env:CLOUDFLARE_ACCOUNT_ID) {
    $env:CLOUDFLARE_ACCOUNT_ID = "bb7eb342a5cfde7c0a84cd9bd519a859"
}

function Test-WranglerAuth {
    if ($env:CLOUDFLARE_API_TOKEN) { return $true }
    $null = & npx wrangler whoami 2>&1 | Out-String
    return ($LASTEXITCODE -eq 0)
}

function Invoke-Wrangler {
    param([string[]]$Args)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $out = & npx @Args 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -ne 0) { Write-Host $out; throw "wrangler failed (exit $code)" }
    return $out
}

Write-Host "=== QTVQ Pages Deploy ===" -ForegroundColor Cyan

if (-not (Test-WranglerAuth)) {
    Write-Host "ERROR: Not logged in. Run: npx wrangler login" -ForegroundColor Red
    Write-Host "Or set env CLOUDFLARE_API_TOKEN for CI."
    exit 1
}

if (-not $SkipKv) {
    $toml = Get-Content "wrangler.toml" -Raw -Encoding UTF8
    if ($toml -notmatch '\[\[kv_namespaces\]\]' -or $toml -notmatch 'id\s*=\s*"[a-f0-9]{32}"') {
        Write-Host ">> Running KV setup ..."
        & powershell -ExecutionPolicy Bypass -File (Join-Path $Root "tools\scripts\setup-kv.ps1")
    } else {
        Write-Host "KV already in wrangler.toml (use -SkipKv to skip)"
    }
}

if (-not (Test-Path ".dev.vars")) {
    Write-Host "Note: no .dev.vars - set PAYMENT_ADMIN_KEY in Dashboard for production." -ForegroundColor Yellow
}

# 绝不直接发布仓库根目录：`wrangler pages deploy .` 会把整个仓库当静态站点发出去，
# 曾导致 cf.env / obs.env / .dev.vars / server/.env / context/ / tmp-*.json 公开可读。
# 也不依赖 .assetsignore —— 实测在 wrangler 4.98 的 Pages 部署路径上它不生效。
# 唯一权威的白名单在 build-pages-public.ps1 里。
$PagesDir = Join-Path $Root "dist\pages-public"
Write-Host ">> Building public allow-list ($PagesDir) ..."
& powershell -ExecutionPolicy Bypass -File (Join-Path $Root "tools\scripts\build-pages-public.ps1") -OutDir $PagesDir
if ($LASTEXITCODE -ne 0) { throw "build-pages-public failed (exit $LASTEXITCODE) - 疑似命中敏感规则，已中止部署" }
if (-not (Test-Path (Join-Path $PagesDir "_headers"))) { throw "发布目录缺少 _headers，中止" }

Write-Host ">> Deploying to Cloudflare Pages ($ProjectName) ..."
$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
# Cloudflare API 会偶发 "The request to Cloudflare's API timed out."（实测同一天 6 次里超时 3 次），
# 与配置无关，重试即可。这里最多试 3 次，避免每次都要人工重跑。
$maxAttempts = 3
$code = 1
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    if ($attempt -gt 1) {
        Write-Host ("   retry " + $attempt + "/" + $maxAttempts + " ...") -ForegroundColor Yellow
        Start-Sleep -Seconds 8
    }
    & npx wrangler pages deploy $PagesDir --project-name=$ProjectName --commit-dirty=true
    $code = $LASTEXITCODE
    if ($code -eq 0) { break }
    Write-Host ("   attempt " + $attempt + " failed (exit " + $code + ")") -ForegroundColor Yellow
}
$ErrorActionPreference = $prev
if ($code -ne 0) { throw "Deploy failed after $maxAttempts attempts (exit $code)" }

Write-Host ""
Write-Host "Deploy OK. Verify in Dashboard:" -ForegroundColor Green
Write-Host "  - Workers AI binding: AI"
Write-Host "  - KV binding: QTVQ_KV"
Write-Host "  - Env: PAYMENT_ADMIN_KEY"
Write-Host "  - API: https://qtvq-api.pages.dev"
Write-Host "  - Static: sync to qtvq.cn via tools/scripts/sync-static.sh"
Write-Host "  - Staff: https://qtvq-api.pages.dev/tools/verify-payment.html"

# 部署后泄露自检：必须在**新部署**上确认这些路径不可访问。
# 一定要带随机查询串，否则会命中 Pages 对非 HTML 资源 7 天的边缘缓存（s-maxage=604800），
# 看到旧内容还在就误判成"没修好"（或反过来，以为漏了却已被缓存挡住）。
Write-Host ""
Write-Host "Post-deploy leak self-check (cache-busted):" -ForegroundColor Cyan
$leakHost = "https://$ProjectName.pages.dev"
$leakPaths = @("/cf.env", "/obs.env", "/.dev.vars", "/server/.env", "/server/src/app.js",
               "/context/CONTEXT-SNAPSHOT.md", "/tmp-chat.json", "/README.md", "/package.json")
$leakBad = 0
foreach ($p in $leakPaths) {
    $url = "$leakHost$p`?__check=$(Get-Random)"
    try {
        $null = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
        Write-Host "  LEAK!! $p 仍可公开访问" -ForegroundColor Red
        $leakBad++
    } catch {
        $sc = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        if ($sc -eq 404) { Write-Host "  ok      $p -> 404" -ForegroundColor DarkGray }
        else { Write-Host "  探测失败 $p -> $sc（网络问题？请手动复检）" -ForegroundColor Yellow }
    }
}
if ($leakBad -gt 0) {
    Write-Host "  ^^^ 有 $leakBad 个敏感路径仍公开！检查 tools/scripts/build-pages-public.ps1 的白名单" -ForegroundColor Red
} else {
    Write-Host "  未发现公开的敏感路径" -ForegroundColor Green
}
