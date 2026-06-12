#!/bin/bash
# 最小化上传：仅 WECHAT_MINI_APP_SECRET + WECHAT_APP_ID（无需 git pull 新脚本）
# 用法：cd /opt/qtvq && bash tools/scripts/upload-mini-secret.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [ -f cf.env ]; then
  set -a
  # shellcheck disable=SC1091
  source cf.env
  set +a
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "ERROR: 请先在 cf.env 中设置 CLOUDFLARE_API_TOKEN"
  exit 1
fi

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-bb7eb342a5cfde7c0a84cd9bd519a859}"

if [ ! -f .dev.vars ]; then
  echo "ERROR: 缺少 .dev.vars（不是 .dev.vsrs）"
  exit 1
fi

put_from_dev() {
  local key="$1"
  local val
  val="$(grep -m1 "^${key}=" .dev.vars | cut -d= -f2- | tr -d '\r' || true)"
  if [ -z "$val" ] || echo "$val" | grep -qE '请填写|请替换|xxxxxxxx'; then
    echo "SKIP $key (未在 .dev.vars 中配置)"
    return 0
  fi
  echo ">> Upload $key ..."
  printf '%s' "$val" | npx wrangler pages secret put "$key" --project-name=qtvq-api
}

put_from_dev WECHAT_APP_ID
put_from_dev WECHAT_MINI_APP_SECRET

echo ">> 验证 health ..."
curl -s "https://qtvq-api.pages.dev/api/health" | grep -o '"wechatMpLoginConfigured":[^,]*' || true
