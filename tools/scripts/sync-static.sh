#!/bin/bash
# 同步静态资源到阿里云 Nginx 目录（不含 functions / API）
# 用法：在 Ubuntu 上 cd /opt/qtvq && bash tools/scripts/sync-static.sh

set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${QTVQ_STATIC_DEST:-/var/www/qtvq}"

if [ ! -f "$ROOT/index.html" ]; then
  echo "ERROR: $ROOT/index.html 不存在，请先在 /opt/qtvq 执行 git pull"
  exit 1
fi

echo ">> 同步 $ROOT -> $DEST"
sudo rsync -av --delete \
  --exclude='functions' \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.wrangler' \
  --exclude='.dev.vars' \
  --exclude='tools' \
  --exclude='context' \
  --exclude='obs.env' \
  "$ROOT/" "$DEST/"

sudo chown -R www-data:www-data "$DEST"
sudo find "$DEST" -type d -exec chmod 755 {} \;
sudo find "$DEST" -type f -exec chmod 644 {} \;

echo ">> 校验关键文件"
test -f "$DEST/index.html"
test -f "$DEST/js/config.js"
test -f "$DEST/js/app.js"
grep -q 'qtvq-api.pages.dev' "$DEST/js/config.js"

echo ">> OK $(date)"
echo "   首页: https://qtvq.cn/"
echo "   API:  https://qtvq-api.pages.dev/api/payment"
