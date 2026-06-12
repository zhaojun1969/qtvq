#!/usr/bin/env python3
"""Upload backup JSON snapshots to Aliyun OSS (S3-compatible)."""

from __future__ import annotations

import json
import mimetypes
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SNAPSHOTS = ROOT / "backup" / "snapshots"


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


def put_file(client, bucket: str, key: str, local: Path) -> None:
    content_type = mimetypes.guess_type(str(local))[0] or "application/octet-stream"
    resp = client.putContent(bucket, key, local.read_bytes(), headers={"Content-Type": content_type})
    status = getattr(resp, "status", 200)
    if status >= 300:
        raise RuntimeError(f"Upload failed {key}: {resp}")


def main() -> None:
    try:
        from obs import ObsClient
    except ImportError:
        print("pip install esdk-obs-python", file=sys.stderr)
        sys.exit(1)

    env = {**load_env(ROOT / "obs.env"), **{k: v for k, v in os.environ.items() if k.startswith("OBS_")}}
    ak = env.get("OBS_ACCESS_KEY_ID")
    sk = env.get("OBS_SECRET_ACCESS_KEY")
    endpoint = env.get("OBS_ENDPOINT")
    bucket = env.get("OBS_BUCKET")
    prefix = (env.get("OSS_BACKUP_PREFIX") or env.get("OBS_BACKUP_PREFIX") or "qtvq/backup/").rstrip("/") + "/"

    if not all([ak, sk, endpoint, bucket]):
        print("Configure obs.env (OBS_* and OSS_BACKUP_PREFIX)", file=sys.stderr)
        sys.exit(1)

    if not SNAPSHOTS.exists():
        print(f"Missing {SNAPSHOTS}", file=sys.stderr)
        sys.exit(1)

    client = ObsClient(access_key_id=ak, secret_access_key=sk, server=endpoint)
    count = 0
    try:
        for path in SNAPSHOTS.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(SNAPSHOTS).as_posix()
            key = prefix + rel
            put_file(client, bucket, key, path)
            print(f"OK {rel} -> {key}")
            count += 1

        from datetime import datetime, timezone
        manifest = {
            "service": "qtvq-api",
            "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source": "publish-backup-snapshots.py",
            "count": count,
        }
        manifest_key = prefix + "manifest.json"
        client.putContent(bucket, manifest_key, json.dumps(manifest, ensure_ascii=False).encode("utf-8"))
        print(f"OK manifest.json -> {manifest_key}")
    finally:
        client.close()

    print(f"Published {count} backup files to {bucket}/{prefix}")


if __name__ == "__main__":
    main()
