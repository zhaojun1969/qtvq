#!/bin/bash
# 写入 js/version.js（同步前调用，便于线上核对版本）
# 用法：bash tools/scripts/write-version.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

sha="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
time="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > js/version.js <<EOF
/** 自动生成，勿手改 */
export const BUILD_SHA = '${sha}';
export const BUILD_TIME = '${time}';
EOF

echo "version.js -> ${sha} @ ${time}"
