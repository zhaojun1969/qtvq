# Upload WeChat Pay secrets from .dev.vars to Cloudflare Pages (qtvq-api)
# Usage: powershell -ExecutionPolicy Bypass -File tools/scripts/upload-wechat-secrets.ps1

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

if (-not (. (Join-Path $PSScriptRoot "load-cf-env.ps1"))) {
    Write-Host "WARN: cf.env not loaded, using wrangler login cache" -ForegroundColor Yellow
}

$Project = "qtvq-api"

$secretKeys = @(
    "WECHAT_MCH_ID",
    "WECHAT_APP_ID",
    "WECHAT_API_V3_KEY",
    "WECHAT_MCH_SERIAL",
    "WECHAT_MCH_PRIVATE_KEY",
    "WECHAT_PAY_NOTIFY_URL",
    "WECHAT_PLATFORM_PUBLIC_KEY",
    "WECHAT_MINI_APP_SECRET",
    "WECHAT_OPEN_APP_ID",
    "WECHAT_OPEN_APP_SECRET",
    "WECHAT_OPEN_REDIRECT_URI"
)

function Get-DevVarValue {
    param([string[]]$Lines, [string]$Key)
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if (-not $Lines[$i].StartsWith("${Key}=")) { continue }
        $value = $Lines[$i].Substring($Key.Length + 1).Trim()
        if ($value -notmatch '-----BEGIN') { return $value }

        # 多行 PEM：**必须取到 END 行**才算完整。
        #
        # ⚠️ 这里曾经有一个隐蔽的、会静默推送"截断私钥"的 bug（2026-09-17 修复）：
        # 旧的中断条件是 `$Lines[$j] -match '^[A-Z][A-Z0-9_]+='`，而 **PowerShell 的 -match 默认不区分大小写**，
        # 于是私钥 base64 的最后一行（形如 `qC51dwLqqLfjglfu6FDj3WM=`，末尾带 = 补位，长度只有 24）
        # 被误判成"下一个变量行"，循环提前中断、`-----END PRIVATE KEY-----` 被丢掉，
        # 推上线的就是一段被截断的私钥（正是 2026-09-16 把支付打成 502 的同一类事故）。
        # 旧私钥因为那一行恰好含 `+` 或 `/`（不在 [A-Z0-9_] 内）而幸免 —— 约 50% 概率，纯靠运气。
        # 现在只认 END；取不到就明确失败，绝不静默截断。
        $parts = @($value)
        $foundEnd = $false
        for ($j = $i + 1; $j -lt $Lines.Count; $j++) {
            $parts += $Lines[$j]
            if ($Lines[$j] -match '-----END') { $foundEnd = $true; break }
        }
        if (-not $foundEnd) {
            throw "变量 $Key 是多行 PEM，但在 .dev.vars 中找不到 END 行（文件可能被截断）—— 拒绝上传不完整的密钥"
        }
        return ($parts -join "`n").Trim()
    }
    return $null
}

function Put-PagesSecret {
    param([string]$Key, [string]$Value)
    if ($Key -eq 'WECHAT_MCH_PRIVATE_KEY') {
        $normScript = Join-Path $PSScriptRoot "normalize-wechat-pem.js"
        $Value = ($Value | node $normScript)
        if ($LASTEXITCODE -ne 0) { throw "normalize-wechat-pem failed" }
    }
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        # 用文件重定向而不是 PowerShell 管道：PS 5.1 的 $OutputEncoding 默认 ASCII，
        # 管道给外部程序时中文会变 "?"（SMS_SIGN_NAME 就这么被推坏过）。
        [System.IO.File]::WriteAllText($tmp, $Value, [System.Text.UTF8Encoding]::new($false))
        $prevOutputEncoding = $OutputEncoding
        $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
        try {
            cmd /c "npx wrangler pages secret put $Key --project-name=$Project < `"$tmp`""
        } finally {
            $OutputEncoding = $prevOutputEncoding
        }
        if ($LASTEXITCODE -ne 0) { throw "wrangler exit $LASTEXITCODE" }
    } finally {
        Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path ".dev.vars")) {
    Write-Host "ERROR: missing .dev.vars" -ForegroundColor Red
    exit 1
}

$lines = Get-Content ".dev.vars" -Encoding UTF8
$uploaded = 0

foreach ($key in $secretKeys) {
    $val = Get-DevVarValue -Lines $lines -Key $key
    if (-not $val -or $val -match '^#|请填写|请替换|xxxxxxxx') { continue }
    Write-Host ">> Upload $key ..."
    try {
        Put-PagesSecret -Key $key -Value $val
        $uploaded++
    } catch {
        Write-Host "ERROR: upload $key failed: $_" -ForegroundColor Red
        exit 1
    }
}

if ($uploaded -eq 0) {
    Write-Host "No WeChat secrets uploaded (uncomment keys in .dev.vars)" -ForegroundColor Yellow
    exit 1
}

Write-Host ">> Uploaded $uploaded WeChat secret(s). Run: npm run deploy:api-only" -ForegroundColor Green
