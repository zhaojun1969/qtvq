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
  `# 仓库根目录里这些属于内部资料，网站不需要` \
  --exclude='README.md' \
  --exclude='DEPLOY.md' \
  --exclude='GITHUB.md' \
  --exclude='package.json' \
  --exclude='package-lock.json' \
  --exclude='cf.env.example' \
  --exclude='obs.env.example' \
  --exclude='.assetsignore' \
  --exclude='.gitattributes' \
  --exclude='.gitignore' \
  --exclude='*.docx' \
  --exclude='EgTqXy3q41.txt' \
  --exclude='pO8yu0YU22.txt' \
  "$ROOT/" "$DEST/"

# ---- 兜底清理 ----
# 注意：rsync 的 `--exclude` 只阻止「拷贝」，**不会删除目标里已存在的同名路径**。
# 历史那次有缺陷的同步已经把 server/ docs/ apps/ cf.env 等拷进了公网目录，
# 光靠 exclude 是清不掉的 —— 必须显式删。曾真实造成
# https://qtvq.cn/server/.env 与 https://qtvq.cn/cf.env 可公开读取。
LEAKED=0

# 1) 密钥类文件
for leak in cf.env obs.env .dev.vars .dev.vsrs .env; do
  if [ -e "$DEST/$leak" ]; then
    echo ">> 清理公网目录中的敏感文件：$leak"
    sudo rm -rf "$DEST/$leak"
    LEAKED=1
  fi
done

# 2) 不该出现在网站根目录的目录（含历史残留）
for stale in server docs apps backup obsidian verify context packages logo tools dist node_modules .git .wrangler functions; do
  if [ -e "$DEST/$stale" ]; then
    echo ">> 清理公网目录中的历史残留目录：$stale/"
    sudo rm -rf "$DEST/$stale"
    LEAKED=1
  fi
done

# 3) 不该公开的根目录文件
for f in README.md DEPLOY.md GITHUB.md package.json package-lock.json cf.env.example obs.env.example .assetsignore .gitattributes .gitignore; do
  if [ -e "$DEST/$f" ]; then
    echo ">> 清理公网目录中的内部文件：$f"
    sudo rm -f "$DEST/$f"
    LEAKED=1
  fi
done

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
