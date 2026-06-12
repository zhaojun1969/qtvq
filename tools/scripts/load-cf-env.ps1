# 加载 cf.env 到当前进程环境变量
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$cfEnv = Join-Path $Root "cf.env"
if (-not (Test-Path $cfEnv)) { return $false }

Get-Content $cfEnv -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or $line -notmatch "=") { return }
    $name, $value = $line -split "=", 2
    $name = $name.Trim().TrimStart([char]0xFEFF)
    $value = $value.Trim().Trim('"').Trim("'")
    if ($name) { Set-Item -Path "Env:$name" -Value $value }
}

if ($env:CLOUDFLARE_API_TOKEN) {
    $t = $env:CLOUDFLARE_API_TOKEN
    $bad = ($t -match '[\u4e00-\u9fff]') -or ($t.Length -lt 30) -or ($t -like '*你的*') -or ($t -like '*在此粘贴*')
    # Cloudflare Custom Token 通常为 40 字符左右，含字母；纯数字或过短多为误填
    if (-not $bad -and $t -notmatch '[A-Za-z]') { $bad = $true }
    if (-not $bad -and $t -match '^\s|\s$|["'']') { $bad = $true }
    if ($bad) {
        Write-Host "ERROR: CLOUDFLARE_API_TOKEN in cf.env is invalid (placeholder or incomplete)." -ForegroundColor Red
        Write-Host "  Token should be ~40 chars from Dashboard, include letters (e.g. cf prefix). See docs/CLOUDFLARE-TOKEN.md"
        return $false
    }
}

return $true
