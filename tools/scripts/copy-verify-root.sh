#!/bin/bash
# 将 verify/ 与根目录 MP_verify*.txt 复制到静态站根目录
# 用法：bash tools/scripts/copy-verify-root.sh [目标目录，默认 QTVQ_STATIC_DEST]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:-${QTVQ_STATIC_DEST:-/var/www/qtvq}}"

copied=0

if [ -d "$ROOT/verify" ]; then
  for f in "$ROOT/verify"/*; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    case "$base" in
      README.md|.gitkeep) continue ;;
    esac
    sudo cp -f "$f" "$DEST/$base"
    echo ">> verify root: $base"
    copied=$((copied + 1))
  done
fi

for f in "$ROOT"/MP_verify*.txt; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  sudo cp -f "$f" "$DEST/$base"
  echo ">> verify root: $base"
  copied=$((copied + 1))
done

if [ "$copied" -eq 0 ]; then
  echo ">> 无校验文件（将 MP_verify*.txt 放入 verify/ 后重试）"
else
  echo ">> 已复制 $copied 个校验文件 -> $DEST"
fi
