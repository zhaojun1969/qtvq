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

# 快照说明
Copy-Item "context\CONTEXT-SNAPSHOT.md" $stage -Force

# 文档
@("README.md", "DEPLOY.md", "GITHUB.md", "package.json", "wrangler.toml", "我心永恒-Q问.txt") | ForEach-Object {
    if (Test-Path $_) { Copy-Item $_ $stage -Force }
}
if (Test-Path "docs") { Copy-Item "docs" (Join-Path $stage "docs") -Recurse -Force }
if (Test-Path ".dev.vars.example") { Copy-Item ".dev.vars.example" $stage -Force }
if (Test-Path "obs.env.example") { Copy-Item "obs.env.example" $stage -Force }

# 对话记录（脱敏）
$transcript = "C:\Users\Administrator\.cursor\projects\d-qtvq\agent-transcripts\0768fe6f-55ab-4903-8309-af1ffa1f4361.jsonl"
$transcriptTxt = "C:\Users\Administrator\.cursor\projects\d-qtvq\agent-transcripts\0768fe6f-55ab-4903-8309-af1ffa1f4361.txt"
$outTranscript = Join-Path $stage "agent-transcript.txt"
if (Test-Path $transcriptTxt) {
    $raw = Get-Content $transcriptTxt -Raw -Encoding UTF8
    $raw = $raw -replace 'ZHao240606@', '[REDACTED_PASSWORD]'
    $raw = $raw -replace 'oauth_token = "[^"]+"', 'oauth_token = "[REDACTED]"'
    Set-Content -Path $outTranscript -Value $raw -Encoding UTF8
} elseif (Test-Path $transcript) {
    Copy-Item $transcript $outTranscript -Force
}

# 源码（排除敏感/体积目录）
$codeZip = Join-Path $dist "qtvq-code-$stamp.zip"
if (Test-Path $codeZip) { Remove-Item $codeZip -Force }
$exclude = @('.git', 'node_modules', '.wrangler', '.tools', 'dist', '.dev.vars', 'obs.env')
$files = Get-ChildItem -Path $Root -Recurse -File | Where-Object {
    $rel = $_.FullName.Substring($Root.Length + 1)
    -not ($exclude | Where-Object { $rel -like "$_*" -or $rel -like "*\$_\*" })
}
# 使用 Compress-Archive 对 staged 再打包整个项目较复杂，改为 robocopy 暂存
$codeStage = Join-Path $stage "project"
New-Item -ItemType Directory -Force -Path $codeStage | Out-Null
robocopy $Root $codeStage /E /XD .git node_modules .wrangler .tools dist /XF .dev.vars obs.env /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$stage\*" -DestinationPath $zip -Force

Remove-Item $stage -Recurse -Force
Write-Host "Created: $zip" -ForegroundColor Green
Write-Host $zip
