#!/bin/bash
# Upload WeChat secrets from .dev.vars to Cloudflare Pages (qtvq-api)
# Usage: bash tools/scripts/upload-wechat-secrets.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PROJECT="qtvq-api"
SCRIPT_DIR="$(dirname "$0")"

if [ -f cf.env ]; then
  set -a
  # shellcheck disable=SC1091
  source cf.env
  set +a
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "ERROR: 请先配置 CLOUDFLARE_API_TOKEN（cf.env 或 export）"
  echo "  cp cf.env.example cf.env && nano cf.env"
  echo "  见 docs/CLOUDFLARE-TOKEN.md"
  exit 1
fi

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-bb7eb342a5cfde7c0a84cd9bd519a859}"

if [ ! -f .dev.vars ]; then
  echo "ERROR: 缺少 .dev.vars（注意文件名是 .dev.vars 不是 .dev.vsrs）"
  exit 1
fi

SECRET_KEYS=(
  WECHAT_MCH_ID
  WECHAT_APP_ID
  WECHAT_API_V3_KEY
  WECHAT_MCH_SERIAL
  WECHAT_MCH_PRIVATE_KEY
  WECHAT_PAY_NOTIFY_URL
  WECHAT_PLATFORM_PUBLIC_KEY
  WECHAT_MINI_APP_SECRET
  WECHAT_OPEN_APP_ID
  WECHAT_OPEN_APP_SECRET
  WECHAT_OPEN_REDIRECT_URI
)

uploaded=0
for key in "${SECRET_KEYS[@]}"; do
  if ! val="$(node "$SCRIPT_DIR/parse-dev-var.mjs" "$key" .dev.vars 2>/dev/null)"; then
    continue
  fi
  if [ "$key" = "WECHAT_MCH_PRIVATE_KEY" ]; then
    val="$(printf '%s' "$val" | node "$SCRIPT_DIR/normalize-wechat-pem.js")"
  fi
  echo ">> Upload $key ..."
  tmp="$(mktemp)"
  printf '%s' "$val" > "$tmp"
  npx wrangler pages secret put "$key" --project-name="$PROJECT" < "$tmp"
  rm -f "$tmp"
  uploaded=$((uploaded + 1))
done

if [ "$uploaded" -eq 0 ]; then
  echo "No WeChat secrets uploaded (uncomment keys in .dev.vars)"
  exit 1
fi

echo ">> Uploaded $uploaded WeChat secret(s)."
echo ">> 验证: curl -s https://qtvq-api.pages.dev/api/health | grep wechatMp"
