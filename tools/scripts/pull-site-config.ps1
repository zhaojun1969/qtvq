#!/usr/bin/env pwsh
<#
.SYNOPSIS
  取回 / 比对本仓库保存的站点主配置副本。

.DESCRIPTION
  站点主配置（`/etc/nginx/sites-enabled/qtvq`）在 2026-10-26 之前只存在于服务器上：
  `deploy/hardening/nginx/*.conf` 只覆盖 conf.d 片段与 server 片段，
  站点 server 块本身没有仓库副本 —— 改动只能"直接上服务器 + 备份到 /root"，无法 review。

  现在仓库里有一份快照：`deploy/hardening/nginx/site-qtvq.conf`。
  本脚本用于刷新它、或检查线上与仓库是否漂移。

  它**不会**写服务器。部署仍走 `deploy/hardening/install.sh`。

.PARAMETER Diff
  只比对，不写文件。有差异时退出码 1（可用于人工巡检）。

.EXAMPLE
  pwsh -File tools/scripts/pull-site-config.ps1          # 刷新仓库副本
  pwsh -File tools/scripts/pull-site-config.ps1 -Diff    # 只看有没有漂移
#>
param(
  [switch]$Diff
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Local = Join-Path $Root 'deploy/hardening/nginx/site-qtvq.conf'
$KeyFile = Join-Path $env:USERPROFILE '.ssh\id_ed25519_yuan'
$SshHost = 'admin@47.115.214.130'
$RemotePath = '/etc/nginx/sites-enabled/qtvq'

function Normalize([string]$text) {
  # 统一换行 + 去掉行尾空白，避免 CRLF/尾随空格造成假漂移
  # 注意：不用 Join-String —— 那是 PowerShell 7 专有命令，本机只有 Windows PowerShell 5.1
  $lines = ($text -replace "`r`n", "`n") -split "`n" | ForEach-Object { $_.TrimEnd() }
  # 再去掉**首尾空行**：头部说明块与正文之间的空行、以及文件末尾换行，
  # 会让"内容其实一致"被误判成漂移（首版就是这样：刷新后 -Diff 仍报不一致）。
  while ($lines.Count -gt 0 -and $lines[0] -eq '') { $lines = $lines[1..($lines.Count - 1)] }
  while ($lines.Count -gt 0 -and $lines[-1] -eq '') { $lines = $lines[0..($lines.Count - 2)] }
  if ($lines.Count -eq 0) { return '' }
  return ($lines -join "`n")
}

Write-Host ">> 读取线上配置 $RemotePath" -ForegroundColor Cyan
$raw = & ssh -i $KeyFile -o BatchMode=yes -o ConnectTimeout=25 $SshHost "cat `$(readlink -f $RemotePath)" 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  throw "读取失败（ssh 退出码 $LASTEXITCODE）：$raw"
}

# 保留仓库副本自带的头部说明，只替换其后的正文
$live = Normalize $raw

if (-not (Test-Path $Local)) {
  throw "仓库副本不存在：$Local"
}
$existing = [IO.File]::ReadAllText($Local, [Text.Encoding]::UTF8)
$marker = "# ============================================================================"
$secondMarker = $existing.IndexOf($marker, $existing.IndexOf($marker) + 1)
$headerEnd = if ($secondMarker -ge 0) { $existing.IndexOf("`n", $secondMarker) } else { -1 }
if ($headerEnd -lt 0) {
  throw "仓库副本缺少头部说明块（找不到两处 $marker 分隔线），无法安全替换"
}
$header = $existing.Substring(0, $headerEnd + 1)
$bodyOld = Normalize $existing.Substring($headerEnd + 1)

if ($Diff) {
  if ($bodyOld -eq $live) {
    Write-Host "✅ 线上与仓库副本一致（$((($live -split "`n").Count)) 行）" -ForegroundColor Green
    exit 0
  }
  Write-Host "❌ 线上与仓库副本不一致" -ForegroundColor Red
  $a = $bodyOld -split "`n"
  $b = $live -split "`n"
  $max = [Math]::Max($a.Count, $b.Count)
  $shown = 0
  for ($i = 0; $i -lt $max -and $shown -lt 40; $i++) {
    $la = if ($i -lt $a.Count) { $a[$i] } else { '' }
    $lb = if ($i -lt $b.Count) { $b[$i] } else { '' }
    if ($la -ne $lb) {
      Write-Host ("  :{0}" -f ($i + 1)) -ForegroundColor Yellow
      Write-Host ("    - 仓库: {0}" -f $la)
      Write-Host ("    + 线上: {0}" -f $lb)
      $shown++
    }
  }
  if ($shown -eq 0) { Write-Host "  （仅行数不同，无逐行差异？）" }
  Write-Host "`n刷新命令：pwsh -File tools/scripts/pull-site-config.ps1" -ForegroundColor Cyan
  exit 1
}

[IO.File]::WriteAllText($Local, ($header + $live + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "✅ 已刷新 $Local（$((($live -split "`n").Count)) 行）" -ForegroundColor Green
