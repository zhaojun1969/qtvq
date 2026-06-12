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

echo ">> 生成 js/version.js"
bash "$ROOT/tools/scripts/write-version.sh"

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

echo ">> 域名校验文件 -> 网站根目录"
bash "$ROOT/tools/scripts/copy-verify-root.sh" "$DEST"

sudo chown -R www-data:www-data "$DEST"
sudo find "$DEST" -type d -exec chmod 755 {} \;
sudo find "$DEST" -type f -exec chmod 644 {} \;

echo ">> 校验关键文件"
test -f "$DEST/index.html"
test -f "$DEST/js/config.js"
test -f "$DEST/js/app.js"
test -f "$DEST/js/layout.js"
test -f "$DEST/js/contact.js"
test -f "$DEST/js/toast.js"
test -f "$DEST/js/home.js"
test -f "$DEST/js/voice-asr.js"
test -f "$DEST/js/version.js"
test -f "$DEST/help.html"
test -f "$DEST/download.html"
test -f "$DEST/privacy.html"
grep -q 'BUILD_SHA' "$DEST/js/version.js"
grep -q 'feature-card-link' "$DEST/index.html"
grep -q 'footer-support' "$DEST/index.html"
grep -q 'initContactModal' "$DEST/js/layout.js"
grep -q 'story-card-clickable' "$DEST/js/home.js"
grep -q 'voice-asr' "$DEST/js/home.js"
grep -q 'prompt:' "$DEST/js/data.js"

echo ">> OK $(date)"
echo "   首页: https://qtvq.cn/"
echo "   API:  https://qtvq-api.pages.dev/api/payment"
