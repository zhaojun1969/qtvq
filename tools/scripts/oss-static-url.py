#!/usr/bin/env python3
"""Generate OSS presigned URL for qtvq-static.tgz (1h)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    return env


def main() -> int:
    try:
        from obs import ObsClient
    except ImportError:
        print("pip install esdk-obs-python", file=sys.stderr)
        return 1

    env = load_env(ROOT / "obs.env")
    ak = env["OBS_ACCESS_KEY_ID"]
    sk = env["OBS_SECRET_ACCESS_KEY"]
    host = env.get("OBS_ENDPOINT", "oss-cn-beijing.aliyuncs.com")
    bucket = env.get("OBS_BUCKET", "qtvq")
    key = "qtvq/context/qtvq-static.tgz"

    client = ObsClient(access_key_id=ak, secret_access_key=sk, server=host)
    try:
        resp = client.createSignedUrl("GET", bucket, key, expires=3600)
        url = resp.signedUrl if hasattr(resp, "signedUrl") else resp
        print(url)
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
