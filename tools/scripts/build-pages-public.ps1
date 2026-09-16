# 构建 Cloudflare Pages 白名单发布目录 —— 本文件只是 build-pages-public.mjs 的薄封装
#
# 白名单与发布前闸门的**唯一实现**在 tools/scripts/build-pages-public.mjs（Node），
# 这样 Windows（本脚本 / deploy.ps1 / post-deploy.ps1）与 Linux（deploy-api.sh）共用同一份清单，
# 不会出现两份白名单各自漂移。要改白名单请改 .mjs，不要在这里加逻辑。
#
# 背景（2026-09-13 事件）：部署脚本原本 `wrangler pages deploy .`，而 wrangler.toml 里
# pages_build_output_dir = "."，等于把整个仓库公开（cf.env / obs.env / .dev.vars /
# server/.env / context/ / tmp-chat.json / README.md / package.json / apps/**）。
# 而 .assetsignore 在 wrangler 4.98 的 Pages 部署路径上实测不生效（连它自己都会被发布）。
# 故改为显式白名单 + 发布前闸门。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/scripts/build-pages-public.ps1
#   powershell -ExecutionPolicy Bypass -File tools/scripts/build-pages-public.ps1 -OutDir dist/other

param(
    [string]$OutDir = "dist/pages-public"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

$builder = Join-Path $PSScriptRoot "build-pages-public.mjs"
if (-not (Test-Path $builder)) {
    Write-Host "ERROR: 找不到 $builder" -ForegroundColor Red
    exit 1
}

& node $builder --out $OutDir
exit $LASTEXITCODE
