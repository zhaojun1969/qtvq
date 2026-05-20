#!/usr/bin/env bash
# macOS/Linux: 创建 KV 并写入 wrangler.toml
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== 我心永恒 Q问 · KV 初始化 ==="
npx wrangler whoami | grep -q "not authenticated" && [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && {
  echo "请先: npx wrangler login"; exit 1;
}

PROD_OUT=$(npx wrangler kv namespace create QTVQ_KV 2>&1)
PREVIEW_OUT=$(npx wrangler kv namespace create QTVQ_KV --preview 2>&1)
echo "$PROD_OUT"
echo "$PREVIEW_OUT"

PROD_ID=$(echo "$PROD_OUT" | grep -oE '[a-f0-9]{32}' | head -1)
PREVIEW_ID=$(echo "$PREVIEW_OUT" | grep -oE '[a-f0-9]{32}' | head -1)

[ -z "$PROD_ID" ] || [ -z "$PREVIEW_ID" ] && { echo "解析 KV id 失败"; exit 1; }

python3 - <<PY
from pathlib import Path
import re
p = Path("wrangler.toml")
text = p.read_text(encoding="utf-8")
block = f'''# 提问额度 / 会员 KV（由 scripts/setup-kv.sh 生成）
[[kv_namespaces]]
binding = "QTVQ_KV"
id = "{PROD_ID}"
preview_id = "{PREVIEW_ID}"
'''
text = re.sub(r"(?s)# 提问额度 / 会员 KV.*?(?=\n\n\[|\n\n# Cloudflare|\Z)", block + "\n\n", text)
if "[[kv_namespaces]]" not in text or "QTVQ_KV" not in text:
    text = text.rstrip() + "\n\n" + block + "\n"
p.write_text(text, encoding="utf-8")
print(f"已写入 wrangler.toml id={PROD_ID} preview_id={PREVIEW_ID}")
PY

echo "完成。请在 Pages Dashboard 绑定 KV 变量名 QTVQ_KV"
