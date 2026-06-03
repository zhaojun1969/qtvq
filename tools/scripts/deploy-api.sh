#!/bin/bash
# Ubuntu 部署 API 到 Cloudflare Pages（qtvq-api）
set -e
cd "$(dirname "$0")/../.."

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "ERROR: 请先 export CLOUDFLARE_API_TOKEN=你的Token"
  exit 1
fi

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-bb7eb342a5cfde7c0a84cd9bd519a859}"

npm install
npm run deploy

echo ">> 自检 /api/health"
curl -s "https://qtvq-api.pages.dev/api/health" | head -c 500
echo ""
