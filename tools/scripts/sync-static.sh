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
  --exclude='.dev.vsrs' \
  --exclude='.dev.vars.*' \
  --exclude='cf.env' \
  --exclude='obs.env' \
  --exclude='tmp-*.json' \
  --exclude='tmp-*.js' \
  --exclude='dist' \
  --exclude='tools' \
  --exclude='context' \
  --exclude='apps' \
  --exclude='backup' \
  --exclude='logo' \
  --exclude='packages' \
  --exclude='docs' \
  --exclude='obsidian' \
  --exclude='verify' \
  --exclude='.github' \
  --exclude='*.pem' \
  --exclude='*.key' \
  `# 后端服务与所有 .env 绝不能进公网目录` \
  --exclude='server' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='*.env' \
  "$ROOT/" "$DEST/"

# 兜底清理：历史同步可能已经把密钥拷进公网目录了（曾真实发生过：
# cf.env 与 server/.env 被公开在 https://qtvq.cn/ 下，必须轮换密钥）
LEAKED=0
for leak in cf.env obs.env .dev.vars .dev.vsrs .env; do
  if [ -e "$DEST/$leak" ]; then
    echo ">> 警告：删除公网目录中的敏感文件 $leak"
    sudo rm -rf "$DEST/$leak"
    LEAKED=1
  fi
done
# server/ 整个目录都不该出现在网站根目录（里面有 .env、源码、数据库脚本）
if [ -d "$DEST/server" ]; then
  echo ">> 警告：删除公网目录中的后端目录 server/（含 .env，绝不能公开）"
  sudo rm -rf "$DEST/server"
  LEAKED=1
fi

# 同步后强制自检：公网目录里不允许存在任何密钥类文件
FOUND="$(sudo find "$DEST" -maxdepth 4 \( -name '.env' -o -name '.env.*' -o -name '*.env' -o -name '*.pem' -o -name '*.key' \) -print 2>/dev/null)"
if [ -n "$FOUND" ]; then
  echo "!! 公网目录中仍存在疑似密钥文件，已删除并中止："
  echo "$FOUND"
  echo "$FOUND" | while read -r f; do [ -n "$f" ] && sudo rm -f "$f"; done
  exit 1
fi
[ "$LEAKED" -eq 1 ] && echo ">> 已清理历史泄露文件；请顺手确认这些密钥是否已在控制台轮换"

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
test -f "$DEST/account.html"
test -f "$DEST/wechat-callback.html"
test -f "$DEST/js/auth.js"
test -f "$DEST/js/account.js"
test -f "$DEST/report.html"
test -f "$DEST/js/report.js"
test -f "$DEST/js/report-api.js"
test -f "$DEST/js/report-share.js"
test -f "$DEST/css/report.css"
test -f "$DEST/pO8yu0YU22.txt"
grep -q 'bbbb6c592fbd78c00beaa494f3943ba2' "$DEST/pO8yu0YU22.txt"
grep -q 'feature-card-link' "$DEST/index.html"
grep -q 'footer-support' "$DEST/index.html"
grep -q 'initContactModal' "$DEST/js/layout.js"
grep -q 'story-card-clickable' "$DEST/js/home.js"
grep -q 'voice-asr' "$DEST/js/home.js"
grep -q 'prompt:' "$DEST/js/data.js"
grep -q 'BUILD_SHA' "$DEST/js/version.js"
grep -q 'js/report.js' "$DEST/report.html"
grep -q 'report.html' "$DEST/index.html"

echo ">> OK $(date)"
echo "   首页: https://qtvq.cn/"
echo "   账户: https://qtvq.cn/account.html"
echo "   API:  https://qtvq-api.pages.dev/api/payment"
