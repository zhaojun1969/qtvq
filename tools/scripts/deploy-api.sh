#!/bin/bash
# Ubuntu / Linux：部署 API 到 Cloudflare Pages（qtvq-api）
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
  echo "ERROR: 请先 export CLOUDFLARE_API_TOKEN 或写入 cf.env"
  echo "  见 docs/CLOUDFLARE-TOKEN.md"
  exit 1
fi

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-bb7eb342a5cfde7c0a84cd9bd519a859}"

bash tools/scripts/write-version.sh

# 绝不发布仓库根目录：wrangler.toml 里 pages_build_output_dir = "."，直接发 "." 等于把
# cf.env / obs.env / .dev.vars / server/ 全部公开（2026-09-13 事件）。必须先构建白名单目录。
echo "=== Build public allow-list ==="
node tools/scripts/build-pages-public.mjs --out dist/pages-public

echo "=== Deploy API (qtvq-api) ==="
npx wrangler pages deploy dist/pages-public --project-name=qtvq-api --commit-dirty=true

echo ""
echo "=== API smoke test ==="
sleep 3
curl -s "https://qtvq-api.pages.dev/api/health" | head -c 600
echo ""
