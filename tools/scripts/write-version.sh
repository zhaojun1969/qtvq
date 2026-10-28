#!/bin/bash
# 写入 js/version.js（同步前调用，便于线上核对版本）
# 用法：bash tools/scripts/write-version.sh
#
# 只写 HEAD 的 sha 不够：工作区有未提交改动时，sha 只代表"最后提交是哪次"，
# 而部署出去的产物比它新，指纹与内容对不上却仍显示 MATCH。所以另写
# BUILD_DIRTY（工作区是否脏）、BUILD_SIG（js/css/根页面 内容指纹）、BUILD_FILES。
# 部署后比对线上 BUILD_SIG 才能确认"线上产物 = 本地产物"。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

sha="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
time="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
  dirty="true"
  dirty_count="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
else
  dirty="false"
  dirty_count=0
fi

# 参与指纹的文件 = 实际会被部署的那些（css/js 全量 + 根目录页面）
# 顺序必须与 write-version.ps1 一致：统一用"去掉 ./ 前缀的相对路径"排序，
# 否则两端会为同一份内容算出不同签名（`./index.html` 与 `js/` 的排序位置和
# 绝对路径排序不同）。文件哈希也统一取 sha256sum 的小写十六进制。
files=()
while IFS= read -r f; do
  rel="${f#./}"
  # js/version.js 是本脚本的输出，必须排除，否则签名会哈希到"上一次写出的那份"，
  # 永远不收敛（两端版本也会互相看到对方刚写的内容而算出不同签名）。
  if [ "$rel" = "js/version.js" ]; then continue; fi
  files+=("$rel")
done < <(
  { find js css -type f \( -name '*.js' -o -name '*.css' \) 2>/dev/null
    find . -maxdepth 1 -type f -name '*.html' | sed 's|^\./||'
  } | LC_ALL=C sort
)

if [ "${#files[@]}" -gt 0 ]; then
  sig="$(for f in "${files[@]}"; do
    printf '%s:%s\n' "${f#./}" "$(sha256sum "$f" | cut -d' ' -f1)"
  done | sha256sum | cut -c1-8)"
else
  sig="00000000"
fi

cat > js/version.js <<EOF
/** 自动生成，勿手改 */
export const BUILD_SHA = '${sha}';
export const BUILD_TIME = '${time}';
export const BUILD_DIRTY = ${dirty};
export const BUILD_SIG = '${sig}';
export const BUILD_FILES = ${#files[@]};
EOF

if [ "$dirty" = "true" ]; then
  echo "version.js -> ${sha} @ ${time} · DIRTY（${dirty_count} 个未提交改动）· sig=${sig} · files=${#files[@]}"
else
  echo "version.js -> ${sha} @ ${time} · clean · sig=${sig} · files=${#files[@]}"
fi
