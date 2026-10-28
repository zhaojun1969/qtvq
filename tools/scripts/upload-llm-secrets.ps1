# 把百炼/通义（DashScope）的 API Key 推送到 Cloudflare Pages（项目 qtvq-api）
#
# 为什么要这个脚本：Pages 侧原来**完全没有通义通道**（只认 Workers AI 绑定），
# 业务方 2026-09-18 决定统一到阿里云百炼（角色模型 qwen-plus-character），
# 于是 Pages 需要一个 DASHSCOPE_API_KEY。手工去 Dashboard 粘很容易粘错/粘坏，
# 这里沿用与 upload-wechat-secrets.ps1 相同的两条纪律：
#   1) 用**文件重定向**而不是 PowerShell 管道（PS 5.1 的 $OutputEncoding 默认 ASCII，
#      管道会把非 ASCII 变成 "?" —— SMS 签名就这么被推坏过一次）；
#   2) 值取不到就明确失败，绝不静默推一个空值/截断值。
#
# key 的来源顺序（都只读本地文件，不打印内容）：
#   1) .dev.vars 的 DASHSCOPE_API_KEY
#   2) server/.env 的 DASHSCOPE_API_KEY   ← 目前的实际来源（Node 侧向量检索用同一把）
#
# 用法: powershell -ExecutionPolicy Bypass -File tools/scripts/upload-llm-secrets.ps1
# 之后: npm run deploy:api-only   然后 npm run check:llm

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

if (-not (. (Join-Path $PSScriptRoot "load-cf-env.ps1"))) {
    Write-Host "WARN: cf.env 未加载，将使用 wrangler login 缓存" -ForegroundColor Yellow
}

$Project = "qtvq-api"

# 只推机密；LLM_CHAIN / TONGYI_* 这些非机密写在 wrangler.toml 的 [vars] 里，随部署生效
$secretKeys = @("DASHSCOPE_API_KEY")

function Get-KeyFromFile {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path $Path)) { return $null }
    foreach ($line in (Get-Content $Path -Encoding UTF8)) {
        # 只匹配"行首就是这个键名"的行，避免把多行 PEM 的 base64 正文误当成键
        if ($line -match "^\s*$([regex]::Escape($Key))\s*=") {
            $v = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
            if ($v) { return $v }
        }
    }
    return $null
}

function Put-PagesSecret {
    param([string]$Key, [string]$Value)
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($tmp, $Value, [System.Text.UTF8Encoding]::new($false))
        $prev = $OutputEncoding
        $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        try {
            cmd /c "npx wrangler pages secret put $Key --project-name=$Project < `"$tmp`""
        } finally {
            $OutputEncoding = $prev
        }
        if ($LASTEXITCODE -ne 0) { throw "wrangler exit $LASTEXITCODE" }
    } finally {
        Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
    }
}

$uploaded = 0
foreach ($key in $secretKeys) {
    $val = Get-KeyFromFile -Path ".dev.vars" -Key $key
    $from = ".dev.vars"
    if (-not $val) {
        $val = Get-KeyFromFile -Path "server/.env" -Key $key
        $from = "server/.env"
    }
    if (-not $val) {
        Write-Host "ERROR: 在 .dev.vars 与 server/.env 里都找不到 $key（拒绝推空值）" -ForegroundColor Red
        exit 1
    }
    Write-Host ">> 推送 $key（来源 $from，长度 $($val.Length)）..." -ForegroundColor Cyan
    try {
        Put-PagesSecret -Key $key -Value $val
        $uploaded++
    } catch {
        Write-Host "ERROR: 推送 $key 失败: $_" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host ">> 已推送 $uploaded 个机密。下一步：" -ForegroundColor Green
Write-Host "   npm run deploy:api-only     # 让 Functions 拿到新的环境变量"
Write-Host "   npm run check:llm           # 验证 /api/health 里 llmChain 与 aiProbe 走到通义"
