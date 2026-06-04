# 上线自检 · qtvq.cn 静态 + qtvq-api（含版本与最新 API 特性）

$ErrorActionPreference = "Continue"
$Api = "https://qtvq-api.pages.dev"
$Web = "https://qtvq.cn"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root
$localSha = git rev-parse --short HEAD 2>$null

function Test-Url($name, $url, $expectCode, $pattern) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
        $ok = $r.StatusCode -eq $expectCode
        if ($pattern -and $r.Content -notmatch $pattern) { $ok = $false }
        $color = if ($ok) { "Green" } else { "Red" }
        Write-Host ("[$name] HTTP $($r.StatusCode) " + $(if ($ok) { "OK" } else { "FAIL" })) -ForegroundColor $color
        return $ok
    } catch {
        Write-Host "[$name] ERROR $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

function Test-PostQuotaBody {
    try {
        $body = '{"clientId":"check_live_post","action":"record"}'
        $r = Invoke-WebRequest -Uri "$Api/api/quota" -Method POST -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 20
        $ok = $r.StatusCode -eq 200 -and $r.Content -match "remaining"
        Write-Host ("[api quota POST body] " + $(if ($ok) { "OK" } else { "FAIL" })) -ForegroundColor $(if ($ok) { "Green" } else { "Red" })
        return $ok
    } catch {
        Write-Host "[api quota POST body] FAIL (old API ignores body.clientId)" -ForegroundColor Red
        return $false
    }
}

Write-Host "=== QTVQ live check (local HEAD: $localSha) ===" -ForegroundColor Cyan
$all = $true
$all = (Test-Url "web home" "$Web/" 200 ".") -and $all
$all = (Test-Url "web config.js" "$Web/js/config.js" 200 "qtvq-api") -and $all
$all = (Test-Url "web app apiUrl" "$Web/js/app.js" 200 "apiUrl") -and $all
$all = (Test-Url "web contact.js" "$Web/js/contact.js" 200 "initContactModal") -and $all
$all = (Test-Url "web index footer" "$Web/index.html" 200 "footer-support") -and $all
$all = (Test-Url "web download" "$Web/download.html" 200 "客户端") -and $all
$all = (Test-Url "api payment" "$Api/api/payment" 200 "company") -and $all
$all = (Test-Url "api quota GET" "$Api/api/quota?clientId=check_live" 200 "remaining") -and $all
$all = (Test-Url "api health" "$Api/api/health" 200 "qtvq-api") -and $all
$all = (Test-PostQuotaBody) -and $all

try {
    $ver = Invoke-WebRequest "$Web/js/version.js" -UseBasicParsing -TimeoutSec 15
    if ($ver.Content -match "BUILD_SHA\s*=\s*'([^']+)'") {
        $remoteSha = $Matches[1]
        $match = ($remoteSha -eq $localSha)
        Write-Host ("[static version] remote=$remoteSha local=$localSha " + $(if ($match) { "MATCH" } else { "OUT OF DATE" })) -ForegroundColor $(if ($match) { "Green" } else { "Yellow" })
        if (-not $match) { $all = $false }
    } else {
        Write-Host "[static version] no version.js on CDN - run sync:static" -ForegroundColor Yellow
        $all = $false
    }
} catch {
    Write-Host "[static version] no version.js on CDN - run sync:static" -ForegroundColor Yellow
    $all = $false
}

if (-not $all) {
    Write-Host ""
    Write-Host "Fix API:    cf.env + npm run deploy:all -SkipStatic" -ForegroundColor Yellow
    Write-Host "Fix static: npm run sync:static  OR server git pull + sync-static.sh" -ForegroundColor Yellow
    exit 1
}
Write-Host ""
Write-Host "All checks passed." -ForegroundColor Green
