# Open Cloudflare Pages project in browser
$urls = @(
    "https://dash.cloudflare.com/bb7eb342a5cfde7c0a84cd9bd519a859/pages/view/qtvq",
    "https://qtvq.pages.dev",
    "https://qtvq.pages.dev/tools/verify-payment.html"
)
foreach ($u in $urls) { Start-Process $u }
Write-Host "Opened: Pages dashboard, production site, staff verify page"
