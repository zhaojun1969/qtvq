# 打包项目上下文（文档 + 对话记录 + 源码，排除密钥）
# 输出: dist/qtvq-context-YYYYMMDD-HHmmss.zip

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dist = Join-Path $Root "dist"
$stage = Join-Path $dist "context-stage-$stamp"
$zip = Join-Path $dist "qtvq-context-$stamp.zip"

New-Item -ItemType Directory -Force -Path $stage | Out-Null

function Redact-Secrets([string]$text) {
    $text = $text -replace 'cfut_[A-Za-z0-9_]+', '[REDACTED_CF_TOKEN]'
    $text = $text -replace 'CLOUDFLARE_API_TOKEN[=:"''\s]+[^\s"'']+', 'CLOUDFLARE_API_TOKEN=[REDACTED]'
    $text = $text -replace 'PAYMENT_ADMIN_KEY[=:"''\s]+[^\s"'']+', 'PAYMENT_ADMIN_KEY=[REDACTED]'
    $text = $text -replace 'oauth_token\s*=\s*"[^"]+"', 'oauth_token="[REDACTED]"'
    $text = $text -replace 'ZHao240606@', '[REDACTED_PASSWORD]'
    $text = $text -replace 'Bearer\s+cfut_[A-Za-z0-9_]+', 'Bearer [REDACTED_CF_TOKEN]'
    return $text
}

# 快照与根目录文档
Copy-Item "context\CONTEXT-SNAPSHOT.md" $stage -Force
@(
    "README.md", "DEPLOY.md", "GITHUB.md", "package.json", "wrangler.toml",
    "我心永恒-Q问.txt", ".dev.vars.example", "obs.env.example"
) | ForEach-Object {
    if (Test-Path $_) { Copy-Item $_ $stage -Force }
}

# 全部 docs 与 apps 说明
if (Test-Path "docs") { Copy-Item "docs" (Join-Path $stage "docs") -Recurse -Force }
if (Test-Path "apps\README.md") { New-Item -ItemType Directory -Force -Path (Join-Path $stage "apps") | Out-Null; Copy-Item "apps\README.md" (Join-Path $stage "apps") -Force }
if (Test-Path "apps\qtvq-uni\README.md") {
    New-Item -ItemType Directory -Force -Path (Join-Path $stage "apps\qtvq-uni") | Out-Null
    Copy-Item "apps\qtvq-uni\README.md" (Join-Path $stage "apps\qtvq-uni") -Force
}

# 对话记录（最新 jsonl，脱敏）
$transcriptDir = "C:\Users\Administrator\.cursor\projects\d-qtvq\agent-transcripts"
$latestJsonl = Get-ChildItem -Path $transcriptDir -Recurse -Filter "*.jsonl" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$outTranscript = Join-Path $stage "agent-transcript.txt"
if ($latestJsonl) {
    $lines = Get-Content $latestJsonl.FullName -Encoding UTF8
    $buf = New-Object System.Text.StringBuilder
    foreach ($line in $lines) {
        if ($line.Length -lt 5) { continue }
        try {
            $obj = $line | ConvertFrom-Json
            $role = $obj.role
            $content = $obj.message.content
            if ($content -is [array]) {
                $content = ($content | ForEach-Object { $_.text }) -join "`n"
            }
            if ($role -and $content) {
                [void]$buf.AppendLine("=== $role ===")
                [void]$buf.AppendLine((Redact-Secrets $content))
                [void]$buf.AppendLine("")
            }
        } catch {
            [void]$buf.AppendLine((Redact-Secrets $line))
        }
    }
    Set-Content -Path $outTranscript -Value $buf.ToString() -Encoding UTF8
    Write-Host "Transcript: $($latestJsonl.FullName)"
} else {
    Set-Content -Path $outTranscript -Value "(no agent transcript found)" -Encoding UTF8
}

# 源码（排除敏感/体积目录）
$codeStage = Join-Path $stage "project"
New-Item -ItemType Directory -Force -Path $codeStage | Out-Null
robocopy $Root $codeStage /E `
    /XD .git node_modules .wrangler .tools dist apps\qtvq-uni\node_modules `
    /XF .dev.vars obs.env `
    /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$stage\*" -DestinationPath $zip -Force

Remove-Item $stage -Recurse -Force
Write-Host "Created: $zip" -ForegroundColor Green
Write-Host $zip
