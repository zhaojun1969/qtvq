# 把 .dev.vars 里的微信支付凭据推到**自建 Node 服务**（/opt/qtvq/server）
#
# 为什么需要这个脚本：
#   现有 upload-wechat-secrets.ps1 / .sh 推的是 Cloudflare Pages（qtvq-api）。
#   2026-10-27 起支付主链路迁到自建 Node，Node 侧必须自己有一份，
#   否则 `/v1/payment/skus` 会报 `wechatConfigured:false`，报告付款走到 stub。
#
# 两条与 Pages 版不同的处理，都是有原因的：
#   1. **私钥与平台公钥写文件，不写 .env**：1.7KB 多行 PEM 放进 .env 会同时被
#      systemd EnvironmentFile 与 dotenv 解析，两者转义规则不同，而 systemd 注入的值优先；
#      写文件没有这个歧义，也避免手改把私钥截断（2026-09-16 支付全 502 就是这么来的）。
#   2. **只推必需项**：MINI_SECRET / OPEN_* 与支付签名无关，不往服务器上多放一份。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/scripts/upload-wechat-secrets-node.ps1
#   powershell -ExecutionPolicy Bypass -File tools/scripts/upload-wechat-secrets-node.ps1 -DryRun

param(
    [switch]$DryRun,
    [string]$KeyFile = $(if ($env:QTVQ_SSH_KEY) { $env:QTVQ_SSH_KEY } else { "$env:USERPROFILE\.ssh\id_ed25519_yuan" }),
    [string]$SshHost = $(if ($env:QTVQ_SSH_HOST) { $env:QTVQ_SSH_HOST } else { "admin@47.115.214.130" }),
    [string]$AppDir = "/opt/qtvq/server"
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

function Fail($text) { Write-Host "✗ $text" -ForegroundColor Red; exit 1 }
function Step($text) { Write-Host ">> $text" -ForegroundColor Cyan }

$devVars = Join-Path $Root ".dev.vars"
if (-not (Test-Path $devVars)) { Fail "缺少 .dev.vars（微信凭据的唯一来源）" }

<#
  多行 PEM 的取值必须读到 END 行才算完整。
  这里沿用了 Pages 版踩过的坑的修法：旧中断条件用 `-match '^[A-Z][A-Z0-9_]+='`，
  而 PowerShell 的 -match 不区分大小写，私钥 base64 最后一行（末尾带 =、长度 24）
  会被误判成变量行 → 静默推一段截断私钥。现在只认 END，取不到就明确失败。
#>
function Get-DevVarValue {
    param([string[]]$Lines, [string]$Key)
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if (-not $Lines[$i].StartsWith("${Key}=")) { continue }
        $value = $Lines[$i].Substring($Key.Length + 1).Trim()
        if ($value -notmatch '-----BEGIN') { return $value }

        $parts = @($value)
        $foundEnd = $false
        for ($j = $i + 1; $j -lt $Lines.Count; $j++) {
            $parts += $Lines[$j]
            if ($Lines[$j] -match '-----END') { $foundEnd = $true; break }
        }
        if (-not $foundEnd) { Fail "变量 $Key 是多行 PEM，但 .dev.vars 里找不到 END 行（文件可能被截断）——拒绝上传" }
        return ($parts -join "`n").Trim()
    }
    return $null
}

$lines = Get-Content $devVars -Encoding UTF8

# 简单值：直接进 .env
$plainKeys = @('WECHAT_MCH_ID', 'WECHAT_APP_ID', 'WECHAT_API_V3_KEY', 'WECHAT_MCH_SERIAL', 'WECHAT_PAY_NOTIFY_URL', 'WECHAT_APP_PAY_ID')
$plain = [ordered]@{}
foreach ($k in $plainKeys) {
    $v = Get-DevVarValue -Lines $lines -Key $k
    if (-not $v -or $v -match '^#|请填写|请替换|xxxxxxxx') { continue }
    $plain[$k] = $v
}

$required = @('WECHAT_MCH_ID', 'WECHAT_APP_ID', 'WECHAT_API_V3_KEY', 'WECHAT_MCH_SERIAL', 'WECHAT_PAY_NOTIFY_URL')
$missing = $required | Where-Object { -not $plain.Contains($_) }
if ($missing) { Fail ("缺少必需项：" + ($missing -join ', ')) }

# 密钥材料：规范化后写文件
$privRaw = Get-DevVarValue -Lines $lines -Key 'WECHAT_MCH_PRIVATE_KEY'
if (-not $privRaw) { Fail "缺少 WECHAT_MCH_PRIVATE_KEY" }
$normScript = Join-Path $PSScriptRoot "normalize-wechat-pem.js"
$privPem = (($privRaw | node $normScript) -join "`n")
if ($LASTEXITCODE -ne 0 -or -not $privPem -or $privPem -notmatch 'BEGIN') { Fail "私钥规范化失败（normalize-wechat-pem）" }

$pubRaw = Get-DevVarValue -Lines $lines -Key 'WECHAT_PLATFORM_PUBLIC_KEY'
if (-not $pubRaw) { Fail "缺少 WECHAT_PLATFORM_PUBLIC_KEY（本商户号是「微信支付公钥」模式，没有它回调验签会全部拒绝）" }

Write-Host "凭据来源：.dev.vars" -ForegroundColor Gray
foreach ($k in $plain.Keys) { Write-Host ("  {0} = {1} 字符" -f $k, $plain[$k].Length) -ForegroundColor Gray }
Write-Host ("  WECHAT_MCH_PRIVATE_KEY = {0} 行（规范化后）" -f ($privPem -split "`n").Count) -ForegroundColor Gray
Write-Host ("  WECHAT_PLATFORM_PUBLIC_KEY = {0} 行" -f ($pubRaw -split "`n").Count) -ForegroundColor Gray

<#
  远端正稿：备份 .env → upsert 简单项 → 写两个 PEM 文件（0600）→ 重启 → 自检。
  .env 里刻意**不写** PEM，只写文件路径；`WECHAT_*_KEY_FILE` 由 wechat-pay.js 的 envOrFile 读取。
#>
$envLines = @()
foreach ($k in $plain.Keys) { $envLines += ("{0}={1}" -f $k, $plain[$k]) }
$envLines += "WECHAT_MCH_PRIVATE_KEY_FILE=$AppDir/secrets/wechat-mch-private-key.pem"
$envLines += "WECHAT_PLATFORM_PUBLIC_KEY_FILE=$AppDir/secrets/wechat-platform-public-key.pem"
# .env 里已有的明文 PEM 要清掉，否则 dotenv 的 inline 值会盖过文件（inline 优先）
$envLines += "WECHAT_MCH_PRIVATE_KEY="
$envLines += "WECHAT_PLATFORM_PUBLIC_KEY="

function B64([string]$text) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) }

$remote = @"
set -euo pipefail
cd '$AppDir'
umask 077
mkdir -p secrets
chmod 700 secrets
cp -a .env ".env.bak.`$(date +%Y%m%d-%H%M%S)"

# 1) 两个 PEM 写文件（base64 传输，避免任何引号/换行被 shell 改写）
printf '%s' '$(B64 $privPem)' | base64 -d > secrets/wechat-mch-private-key.pem
printf '%s' '$(B64 $pubRaw)'  | base64 -d > secrets/wechat-platform-public-key.pem
chmod 600 secrets/wechat-mch-private-key.pem secrets/wechat-platform-public-key.pem

# 2) .env upsert：先删同名行，再追加（保留文件其余内容与已有注释）
python3 - <<'PYEOF'
import io
env_path = '.env'
pairs = []
for line in '''$(($envLines -join "`n"))'''.splitlines():
    if not line: continue
    k, _, v = line.partition('=')
    pairs.append((k, v))
text = io.open(env_path, encoding='utf-8').read().splitlines()
keys = {k for k, _ in pairs}
out = [l for l in text if not (l and l.split('=', 1)[0].strip() in keys)]
for k, v in pairs:
    out.append(f'{k}={v}')
io.open(env_path, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print('env upserted:', ', '.join(k for k, _ in pairs))
PYEOF

# 3) 重启并自检（服务读不到密钥时会报 wechatConfigured=false）
systemctl restart qtvq-report
sleep 3
systemctl is-active qtvq-report
grep -c '^WECHAT_MCH_ID=' .env
stat -c '%a %U %n' secrets/wechat-mch-private-key.pem secrets/wechat-platform-public-key.pem
"@

if ($DryRun) {
    Write-Host "`n--- DryRun：以下内容本应推到 ${SshHost}:${AppDir} ---" -ForegroundColor Yellow
    Write-Host ("会写入 .env 的键：" + (($plain.Keys + 'WECHAT_MCH_PRIVATE_KEY_FILE', 'WECHAT_PLATFORM_PUBLIC_KEY_FILE') -join ', '))
    Write-Host "会写入的密钥文件：secrets/wechat-mch-private-key.pem（600）、secrets/wechat-platform-public-key.pem（600）"
    exit 0
}

# 通过 stdin 传脚本，不用命令行参数：整段 payload 里有私钥，
# 放进 argv 会短暂出现在服务器 ps 输出里。sudo 读 stdin 执行（服务目录属 root）。
Step "推送到 ${SshHost}:${AppDir}"
<#
  传输方式：base64 写临时文件 → scp → 远端 `base64 -d | sudo bash`。
  不用 `$b64 | ssh ...`：PS 5.1 把字符串管道给原生程序时编码不可靠（实测远端报
  `base64: invalid input`），而 scp 是字节级传输，不会有任何编码介入。
#>
$b64 = B64 $remote
$tmpB64 = Join-Path ([IO.Path]::GetTempPath()) ("qtvq-wechat-" + [guid]::NewGuid().ToString('N') + ".b64")
[IO.File]::WriteAllText($tmpB64, $b64, [System.Text.UTF8Encoding]::new($false))
$remoteB64 = "/tmp/qtvq-wechat-" + [guid]::NewGuid().ToString('N') + ".b64"
try {
    & scp -i $KeyFile -o BatchMode=yes $tmpB64 "${SshHost}:${remoteB64}" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "scp 上传失败" }
    $out = (& ssh -i $KeyFile -o BatchMode=yes $SshHost "base64 -d $remoteB64 | sudo bash; rc=`$?; rm -f $remoteB64; exit `$rc" 2>&1 | Out-String)
} finally {
    Remove-Item $tmpB64 -Force -ErrorAction SilentlyContinue
}
Write-Host $out

if ($out -notmatch '(?m)^active\s*$') { Fail "服务未起来，见上面的输出" }

Step "自检：/v1/payment/skus 的 wechatConfigured"
$check = @"
cd '$AppDir'
PORT=`$(grep -m1 '^PORT=' .env | cut -d= -f2-); PORT=`${PORT:-3000}
curl -s "http://127.0.0.1:`$PORT/v1/payment/skus" | head -c 400
"@
$out2 = ((B64 $check) | & ssh -i $KeyFile -o BatchMode=yes $SshHost 'tr -d "\r" | base64 -di | bash' 2>&1 | Out-String)
Write-Host $out2
if ($out2 -match '"wechatConfigured"\s*:\s*false') { Fail "wechatConfigured 仍为 false —— 密钥没被读到（检查 secrets/ 权限与 *_FILE 路径）" }

Write-Host ""
Write-Host "✅ 微信支付凭据已落到 Node 服务，且 wechatConfigured=true" -ForegroundColor Green
Write-Host "   下一步：node tools/scripts/check-wechat-pay-node.mjs   # 真实下单验证签名与商户证书" -ForegroundColor Gray
