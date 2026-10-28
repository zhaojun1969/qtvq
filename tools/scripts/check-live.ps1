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
$all = (Test-Url "web app apiFetch" "$Web/js/app.js" 200 "apiFetch") -and $all
$all = (Test-Url "web contact.js" "$Web/js/contact.js" 200 "initContactModal") -and $all
$all = (Test-Url "web index footer" "$Web/index.html" 200 "footer-support") -and $all
$all = (Test-Url "web download" "$Web/download.html" 200 "download-config") -and $all
$all = (Test-Url "api payment" "$Api/api/payment" 200 "company") -and $all
$all = (Test-Url "api quota GET" "$Api/api/quota?clientId=check_live" 200 "remaining") -and $all
$all = (Test-Url "api health" "$Api/api/health" 200 "qtvq-api") -and $all
$all = (Test-PostQuotaBody) -and $all

try {
    $ver = Invoke-WebRequest "$Web/js/version.js" -UseBasicParsing -TimeoutSec 15
    if ($ver.Content -match 'BUILD_SHA\s*=\s*''([a-f0-9]+)''') {
        $remoteSha = $Matches[1]
        $match = ($remoteSha -eq $localSha)
        Write-Host ('[static version] remote=' + $remoteSha + ' local=' + $localSha + ' ' + $(if ($match) { 'MATCH' } else { 'OUT OF DATE' })) -ForegroundColor $(if ($match) { 'Green' } else { 'Yellow' })
        if (-not $match) { $all = $false }
    } else {
        Write-Host '[static version] no version.js on CDN - run sync:static' -ForegroundColor Yellow
        $all = $false
    }

    # 只比 BUILD_SHA 是不够的：工作区有未提交改动时，sha 两边一样但内容并不一样
    # （本仓库常态就是几百个未提交文件），结果是"显示 MATCH、实际装的是另一份代码"。
    # 所以再比 BUILD_SIG（css/js/根页面 的内容指纹），它只随内容变。
    $localVerPath = Join-Path $Root 'js/version.js'
    if (Test-Path $localVerPath) {
        $localVer = Get-Content $localVerPath -Raw
        $localSigMatch = [regex]::Match($localVer, "BUILD_SIG\s*=\s*'([a-z0-9]+)'")
        $remoteSigMatch = [regex]::Match($ver.Content, "BUILD_SIG\s*=\s*'([a-z0-9]+)'")
        if ($localSigMatch.Success -and $remoteSigMatch.Success) {
            $localSig = $localSigMatch.Groups[1].Value
            $remoteSig = $remoteSigMatch.Groups[1].Value
            $sigSame = ($localSig -eq $remoteSig)
            Write-Host ('[static content] remote=' + $remoteSig + ' local=' + $localSig + ' ' + $(if ($sigSame) { 'MATCH' } else { 'OUT OF DATE' })) -ForegroundColor $(if ($sigSame) { 'Green' } else { 'Yellow' })
            if (-not $sigSame) { $all = $false }
            if ($localVer -match 'BUILD_DIRTY\s*=\s*true') {
                Write-Host '[static content] 本地工作区 DIRTY：BUILD_SHA 只代表最后一次提交，版本以 BUILD_SIG 为准' -ForegroundColor Yellow
            }
        } else {
            Write-Host '[static content] 缺少 BUILD_SIG（旧版 version.js 或线上未更新）' -ForegroundColor Yellow
            $all = $false
        }
    }
} catch {
    Write-Host '[static version] no version.js on CDN - run sync:static' -ForegroundColor Yellow
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
