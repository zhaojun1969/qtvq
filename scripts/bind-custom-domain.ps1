# Bind qtvq.cn / www.qtvq.cn to Pages project qtvq (API)
# DNS CNAME must exist in zone - if OAuth lacks DNS write, add records in Dashboard
# Usage: powershell -ExecutionPolicy Bypass -File scripts/bind-custom-domain.ps1

$ErrorActionPreference = "Stop"
$acct = "bb7eb342a5cfde7c0a84cd9bd519a859"
$project = "qtvq"
$configPath = "$env:USERPROFILE\AppData\Roaming\xdg.config\.wrangler\config\default.toml"
if (-not (Test-Path $configPath)) { throw "Run: npx wrangler login" }
$toml = Get-Content $configPath -Raw
if ($toml -notmatch 'oauth_token = "([^"]+)"') { throw "No oauth token in wrangler config" }
$token = $Matches[1]
$hdr = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }
$base = "https://api.cloudflare.com/client/v4/accounts/$acct/pages/projects/$project/domains"

Write-Host "=== Bind custom domains to Pages ===" -ForegroundColor Cyan
foreach ($domain in @("qtvq.cn", "www.qtvq.cn")) {
  try {
    $body = (@{ name = $domain } | ConvertTo-Json)
    $r = Invoke-RestMethod -Uri $base -Headers $hdr -Method Post -Body $body
    Write-Host "[OK] $domain status=$($r.result.status)"
  } catch {
    $msg = $_.ErrorDetails.Message
    if ($msg -match 'already exists') { Write-Host "[SKIP] $domain already added" }
    else { Write-Host "[WARN] $domain $msg" }
  }
}

$list = Invoke-RestMethod -Uri $base -Headers $hdr
$list.result | ForEach-Object {
  Write-Host "  $($_.name) -> status=$($_.status) $($_.verification_data.error_message)"
}

Write-Host ""
Write-Host "If status=pending / CNAME not set, open DNS in Dashboard:" -ForegroundColor Yellow
Write-Host "  https://dash.cloudflare.com/e6e39f6e75301e5116ca38c93a4a10ad/qtvq.cn/dns/records"
Write-Host "  Add/Fix:"
Write-Host "    Type CNAME  Name @   Target qtvq.pages.dev  Proxy ON"
Write-Host "    Type CNAME  Name www Target qtvq.pages.dev  Proxy ON"
Write-Host "  Do NOT use URL redirect to https://qtvq.pages.dev/"
Write-Host ""
Write-Host "Then: npm run deploy"
