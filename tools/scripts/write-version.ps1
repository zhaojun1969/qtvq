# 写入 js/version.js（部署/同步前调用，便于线上核对版本）
#
# 为什么不能只写 HEAD 的 sha：
# 本仓库长期存在大批未提交改动（本次实测 351 个文件），这时 `git rev-parse HEAD`
# 只说明"最后提交是哪次"，而部署出去的产物比它新。指纹与内容对不上，线上核对
# 仍会显示 MATCH，看不出装的是另一份代码 —— 这比没有指纹更误导。
#
# 所以额外写三个字段：
#   BUILD_DIRTY  工作区是否有未提交改动（true 时 BUILD_SHA 不能当"这是哪个提交"用）
#   BUILD_SIG    本次纳入部署的 js / css / 根目录 html 的内容指纹（8 位，SHA-256 前缀）
#   BUILD_FILES  参与指纹的文件数
# 部署后比对线上 version.js 的 BUILD_SIG，才能确认"线上产物 = 本地产物"。

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

$sha = (git rev-parse --short HEAD 2>$null)
if (-not $sha) { $sha = "unknown" }

$dirtyLines = @(git status --porcelain 2>$null)
$dirty = $dirtyLines.Count -gt 0

$time = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# 参与指纹的文件 = 实际会被部署的那些（css/js 全量 + 根目录页面），目录不参与
$files = New-Object System.Collections.Generic.List[System.IO.FileInfo]
foreach ($dir in @("js", "css")) {
    if (Test-Path $dir) {
        Get-ChildItem -Path $dir -Recurse -File -Include *.js, *.css | ForEach-Object { $files.Add($_) }
    }
}
Get-ChildItem -Path $Root -File -Filter "*.html" | ForEach-Object { $files.Add($_) }

$lines = New-Object System.Collections.Generic.List[string]
# 顺序与大小写必须与 write-version.sh 完全一致，否则同一份内容两端算出不同签名：
#  - 排序用 **Ordinal（字节序）**，对齐 bash 的 `LC_ALL=C sort`。PowerShell 默认排序是
#    culture-aware，会把 `-` `.` 当可忽略字符 —— `js/adult-gate.js` 与 `js/adult.js`
#    在两种排序下先后相反，签名就会漂。
#  - Get-FileHash 输出大写十六进制，sha256sum 是小写，统一转小写。
#
# `js/version.js` **必须排除**：它自己就是本脚本的输出。把它算进指纹，
# 每次运行都会哈希到"上一次写出的那份"，签名永远不收敛（第一次实现时
# PowerShell 与 bash 两版算出的签名就是不一样，正是因为互相看到了对方刚写的 version.js）。
$rels = New-Object System.Collections.Generic.List[string]
foreach ($f in $files) {
    $rel = $f.FullName.Substring($Root.Length + 1).Replace('\', '/')
    if ($rel -eq 'js/version.js') { continue }
    $rels.Add($rel)
}
$rels.Sort([System.StringComparer]::Ordinal)
foreach ($rel in $rels) {
    $fileHash = (Get-FileHash -LiteralPath (Join-Path $Root $rel) -Algorithm SHA256).Hash.ToLower()
    $lines.Add("$rel`:$fileHash")
}
# 尾部换行不能少：bash 侧把逐行输出整段管道给 sha256sum，文本以换行结尾；
# PowerShell 的 -join 不带尾换行，同一份内容会算出不同签名（实测就差这一个字节）。
$joined = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n") + "`n")
$hasher = [System.Security.Cryptography.SHA256]::Create()
$sig = ([System.BitConverter]::ToString($hasher.ComputeHash($joined)) -replace "-", "").Substring(0, 8).ToLower()
$hasher.Dispose()

$dirtyJs = $dirty.ToString().ToLower()

$content = @"
/** 自动生成，勿手改 */
export const BUILD_SHA = '$sha';
export const BUILD_TIME = '$time';
export const BUILD_DIRTY = $dirtyJs;
export const BUILD_SIG = '$sig';
export const BUILD_FILES = $($rels.Count);
"@

Set-Content -Path "js/version.js" -Value $content -Encoding UTF8
$state = if ($dirty) { "DIRTY（$($dirtyLines.Count) 个未提交改动，sha 仅代表最后提交）" } else { "clean" }
Write-Host "version.js -> $sha @ $time · $state · sig=$sig · files=$($rels.Count)"
