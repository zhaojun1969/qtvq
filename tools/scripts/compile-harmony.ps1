# 编译 / 运行鸿蒙原生应用（uni-app x 工程）
#
# 为什么需要脚本，而不是让人记命令：这一套里有三个坑，都是实测踩出来的：
#   ① `cli.exe` **要求 HBuilderX 处于运行状态**，否则报"未检测到已打开的HBuilderX"；
#   ② HBuilderX 需要知道 DevEco Studio 的路径，键名是 `harmony.devTools.path`，
#      而且本机原本指向 `D:/Huawei/DevEco Studio`（带空格）—— **该目录并不存在**，
#      实际是 `D:/Huawei/DevEcoStudio`。路径不对时报"未检测到鸿蒙工具链"，
#      看起来像"鸿蒙环境没装"，很容易误判；本脚本会自动核对并纠正。
#   ③ 编译/打包日志混着大量进度行，成败要看关键词，不能只看退出码（退出码恒为 0）。
#
# 用法:
#   pwsh tools/scripts/compile-harmony.ps1 -CompileOnly   # 只编译（最快，用于验证代码）
#   pwsh tools/scripts/compile-harmony.ps1                # 编译并出 .hap 运行包
#
# 产物：apps/qtvq-uniappx/unpackage/dist/dev/app-harmony/entry/build/default/outputs/default/*.hap
# 注意：**运行/调试流程用的是"标准基座"，包名固定为 io.dcloud.uniappx**，
#      所以会看到"未正确配置鸿蒙应用的包名"的提示 —— 那是正常的。
#      要让自己的包名（cn.qtvq.harmony）生效、并做正式签名，需要：
#        · 登录 DCloud 账号（`cli publish app-harmony` 会要求登录）
#        · 华为开发者账号 + 签名证书（.p12/.cer/.p7b）

param(
    [string]$Project = "",
    [switch]$CompileOnly,
    [string]$DevEcoPath = "D:/Huawei/DevEcoStudio",
    [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

if (-not $Project) { $Project = Join-Path $Root "apps\qtvq-uniappx" }
if (-not (Test-Path $Project)) { Write-Host "ERROR: 找不到工程 $Project" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 找 HBuilderX
$hbCandidates = @(
    "D:\HBuilderX.4.85.2025110510\HBuilderX",
    "$env:ProgramFiles\HBuilderX",
    "D:\HBuilderX"
)
$hb = $hbCandidates | Where-Object { Test-Path (Join-Path $_ "cli.exe") } | Select-Object -First 1
if (-not $hb) { Write-Host "ERROR: 找不到 HBuilderX（cli.exe）。请在脚本里补上安装路径。" -ForegroundColor Red; exit 1 }
$cli = Join-Path $hb "cli.exe"
Write-Host "HBuilderX: $hb" -ForegroundColor Cyan

# ---------------------------------------------------------------- 确认工具链路径
if (-not (Test-Path $DevEcoPath)) {
    Write-Host "ERROR: DevEco Studio 不在 $DevEcoPath —— 请用 -DevEcoPath 指定实际安装路径" -ForegroundColor Red
    exit 1
}

# HBuilderX 必须在运行，cli 才能工作
$hbRunning = Get-Process -Name "HBuilderX" -ErrorAction SilentlyContinue
if (-not $hbRunning) {
    Write-Host ">> 启动 HBuilderX（cli 需要它常驻）..."
    Start-Process -FilePath (Join-Path $hb "HBuilderX.exe") -WindowStyle Minimized | Out-Null
    Start-Sleep -Seconds 25
}

# 核对并纠正鸿蒙工具链路径（见文件头 ②）
$before = & $cli config get --key "harmony.devTools.path" 2>&1 | Out-String
$before = $before.Trim()
if ($before -ne $DevEcoPath) {
    Write-Host ">> 纠正 harmony.devTools.path：$before  →  $DevEcoPath" -ForegroundColor Yellow
    & $cli config set --key "harmony.devTools.path" --value $DevEcoPath | Out-Null
} else {
    Write-Host ">> harmony.devTools.path 已正确：$before"
}

# ---------------------------------------------------------------- 编译
$logDir = Join-Path $Root "dist"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "harmony-build.log"

$args = @("launch", "app-harmony", "--project", $Project)
if ($CompileOnly) { $args += @("--compile", "true") }
Write-Host ">> 执行: cli $($args -join ' ')" -ForegroundColor Cyan

$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $cli @args 2>&1 | Tee-Object -FilePath $log | Out-Null
$ErrorActionPreference = $prev

# ---------------------------------------------------------------- 判读（不能只看退出码）
$lines = Get-Content $log -Encoding UTF8
$errors = $lines | Select-String -Pattern 'ERROR' | Where-Object { $_.Line -notmatch '0 error' }
$okCompile = ($lines | Select-String -Pattern '编译成功').Count -gt 0
$okHap = ($lines | Select-String -Pattern '运行包制作成功').Count -gt 0

Write-Host ""
Write-Host "=== 结果 ===" -ForegroundColor Cyan
Write-Host "  工程编译   : $(if ($okCompile) { '成功 ✅' } else { '未确认 ❌' })"
if (-not $CompileOnly) { Write-Host "  运行包 .hap: $(if ($okHap) { '制作成功 ✅' } else { '未产出 ❌' })" }

if ($errors) {
    Write-Host "  编译期报错（uvue 的样式/语法限制最容易在这里暴露）：" -ForegroundColor Yellow
    $errors | Select-Object -First 10 | ForEach-Object { Write-Host ("    " + $_.Line.Trim()) }
} else {
    Write-Host "  编译期报错 : 无 ✅"
}

# 提示"包名未配置 / 未签名"是运行流程的正常现象，不是失败
if (($lines | Select-String -Pattern '未正确配置鸿蒙应用的包名').Count -gt 0) {
    Write-Host ""
    Write-Host "  说明：出现「包名未正确配置」是**正常**的 —— 运行/调试用的是标准基座（包名固定 io.dcloud.uniappx）。" -ForegroundColor Gray
    Write-Host "        要让 cn.qtvq.harmony 生效并正式签名：登录 DCloud 账号 + 华为开发者证书。" -ForegroundColor Gray
}

$haps = @()
if (Test-Path (Join-Path $Project "unpackage\dist\dev\app-harmony")) {
    $haps = Get-ChildItem (Join-Path $Project "unpackage\dist\dev\app-harmony") -Recurse -Filter *.hap -ErrorAction SilentlyContinue
}
if ($haps) {
    Write-Host ""
    Write-Host "  产出：" -ForegroundColor Green
    $haps | ForEach-Object { Write-Host ("    " + $_.Name + "  " + [math]::Round($_.Length/1MB,2) + " MB") }
}

Write-Host ""
if ($errors -or -not $okCompile) {
    Write-Host "❌ 编译未通过，完整日志：$log" -ForegroundColor Red
    exit 1
}
Write-Host "✅ 编译通过。日志：$log" -ForegroundColor Green
