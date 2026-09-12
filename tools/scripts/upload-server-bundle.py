#!/usr/bin/env python3
"""Package `server/` and publish it to OSS, then print a time-limited signed URL.

Why this exists: the production ECS can reach OSS but has no usable SSH key from
this Windows profile, and GitHub/Gitee are not dependable from here. The static
site is already deployed through this same bucket (`sync-static-from-oss.sh`),
so this reuses a path that is known to work from the server.

Usage:
    python tools/scripts/upload-server-bundle.py
    python tools/scripts/upload-server-bundle.py --expires 604800   # 7 days
"""

from __future__ import annotations

import argparse
import os
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVER_DIR = ROOT / "server"
DIST = ROOT / "dist"
BUNDLE_NAME = "qtvq-server.tgz"
DEFAULT_PREFIX = "qtvq/srv/"
EXCLUDE_PARTS = {"node_modules", ".git", "__pycache__", "dist", "coverage"}
EXCLUDE_FILES = {".env", "boot-out.txt", "boot-err.txt"}


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def tar_filter(info: tarfile.TarInfo):
    parts = Path(info.name).parts
    if any(p in EXCLUDE_PARTS for p in parts):
        return None
    if Path(info.name).name in EXCLUDE_FILES:
        return None
    # 归一化权限：源码不该带可执行位差异
    if info.isfile():
        info.mode = 0o644
    return info


def build_bundle() -> Path:
    DIST.mkdir(exist_ok=True)
    out = DIST / BUNDLE_NAME
    print(f">> 打包 {SERVER_DIR} -> {out}")
    with tarfile.open(out, "w:gz") as tar:
        tar.add(SERVER_DIR, arcname="server", filter=tar_filter)
    size_kb = out.stat().st_size / 1024
    with tarfile.open(out, "r:gz") as tar:
        names = tar.getnames()
    print(f"   文件数 {len(names)}，大小 {size_kb:.1f} KB")
    if not any(n.endswith("server/src/app.js") for n in names):
        print("!! 打包内容异常：缺少 server/src/app.js", file=sys.stderr)
        sys.exit(1)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expires", type=int, default=86400, help="签名有效期（秒），默认 24 小时")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX, help="OSS 前缀，默认 qtvq/srv/")
    args = parser.parse_args()

    try:
        from obs import ObsClient
    except ImportError:
        print("缺少依赖：pip install esdk-obs-python", file=sys.stderr)
        return 1

    env = {**load_env(ROOT / "obs.env"), **{k: v for k, v in os.environ.items() if k.startswith("OBS_")}}
    ak = env.get("OBS_ACCESS_KEY_ID")
    sk = env.get("OBS_SECRET_ACCESS_KEY")
    endpoint = env.get("OBS_ENDPOINT")
    bucket = env.get("OBS_BUCKET")
    if not all([ak, sk, endpoint, bucket]):
        print("obs.env 缺少 OBS_ACCESS_KEY_ID / OBS_SECRET_ACCESS_KEY / OBS_ENDPOINT / OBS_BUCKET", file=sys.stderr)
        return 1

    local = build_bundle()
    key = args.prefix.rstrip("/") + "/" + local.name

    client = ObsClient(access_key_id=ak, secret_access_key=sk, server=endpoint)
    try:
        resp = client.putFile(bucket, key, str(local))
        status = getattr(resp, "status", 200)
        if status >= 300:
            print(f"上传失败 status={status} {resp}", file=sys.stderr)
            return 1
        print(f">> 已上传 oss://{bucket}/{key}")

        signed = client.createSignedUrl("GET", bucket, key, expires=args.expires)
        url = getattr(signed, "signedUrl", None)
        if not url:
            print(f"签名失败：{signed}", file=sys.stderr)
            return 1
    finally:
        client.close()

    hours = args.expires / 3600
    print()
    print("=" * 72)
    print(f"签名 URL（{hours:.1f} 小时内有效，请勿外传）：")
    print(url)
    print("=" * 72)
    print()
    print("在服务器上执行（一次性，之后仓库目录里就有 server/ 了）：")
    print()
    print("  cd /opt/qtvq                 # 仓库克隆目录；若不存在改成你的实际路径")
    print(f"  curl -fSL -o /tmp/{BUNDLE_NAME} '{url}'")
    print(f"  tar -xzf /tmp/{BUNDLE_NAME} -C /opt/qtvq && rm -f /tmp/{BUNDLE_NAME}")
    print("  ls server/src/app.js         # 确认落地")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
