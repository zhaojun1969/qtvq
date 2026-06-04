#!/bin/bash
# 从 OSS 拉取 qtvq-static.tgz 解压到 Nginx 目录（服务器上执行）
# 用法：cd /opt/qtvq && bash tools/scripts/sync-static-from-oss.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${QTVQ_STATIC_DEST:-/var/www/qtvq}"
ENV_FILE="${OBS_ENV:-$ROOT/obs.env}"
TMP="/tmp/qtvq-static.tgz"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
fi

: "${OBS_ACCESS_KEY_ID:?missing OBS_ACCESS_KEY_ID}"
: "${OBS_SECRET_ACCESS_KEY:?missing OBS_SECRET_ACCESS_KEY}"
: "${OBS_ENDPOINT:=oss-cn-beijing.aliyuncs.com}"
: "${OBS_BUCKET:=qtvq}"

PREFIX="${OBS_STATIC_PREFIX:-${OBS_PREFIX:-qtvq/static/}}"
KEY="${PREFIX}qtvq-static.tgz"
HOST="${OBS_ENDPOINT#https://}"
HOST="${HOST#http://}"

echo ">> Download oss://${OBS_BUCKET}/${KEY}"
python3 - <<'PY' "$OBS_ACCESS_KEY_ID" "$OBS_SECRET_ACCESS_KEY" "$HOST" "$OBS_BUCKET" "$KEY" "$TMP"
import sys
from obs import ObsClient

ak, sk, host, bucket, key, out = sys.argv[1:7]
client = ObsClient(access_key_id=ak, secret_access_key=sk, server=host)
try:
    resp = client.getObject(bucket, key, downloadPath=out)
    if getattr(resp, "status", 200) >= 300:
        raise SystemExit(f"download failed: {resp}")
finally:
    client.close()
print("OK", out)
PY

sudo mkdir -p "$DEST"
sudo tar -xzf "$TMP" -C "$DEST"
sudo chown -R www-data:www-data "$DEST"
rm -f "$TMP"

test -f "$DEST/js/voice-asr.js"
grep -q voice-asr "$DEST/js/home.js"
grep -q initContactModal "$DEST/js/layout.js"
echo ">> Static OK from OSS -> $DEST"
