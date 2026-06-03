# 上线自检 · qtvq.cn 静态 + qtvq-api

$ErrorActionPreference = "Continue"
$Api = "https://qtvq-api.pages.dev"
$Web = "https://qtvq.cn"

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

Write-Host "=== QTVQ live check ===" -ForegroundColor Cyan
$all = $true
$all = (Test-Url "web home" "$Web/" 200 ".") -and $all
$all = (Test-Url "web config.js" "$Web/js/config.js" 200 "qtvq-api") -and $all
$all = (Test-Url "web app apiUrl" "$Web/js/app.js" 200 "apiUrl") -and $all
$all = (Test-Url "api payment" "$Api/api/payment" 200 "company") -and $all
$all = (Test-Url "api quota" "$Api/api/quota?clientId=check_live" 200 "remaining") -and $all

if (-not $all) {
    Write-Host ""
    Write-Host "Fix static: on Ubuntu run: cd /opt/qtvq && git pull && bash tools/scripts/sync-static.sh" -ForegroundColor Yellow
    Write-Host "Fix API: npm run deploy" -ForegroundColor Yellow
    exit 1
}
Write-Host ""
Write-Host "All checks passed." -ForegroundColor Green
