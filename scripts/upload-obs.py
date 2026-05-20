#!/usr/bin/env python3
"""Upload context bundle to Huawei Cloud OBS (or S3-compatible endpoint)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


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


def pick_latest_zip(dist: Path) -> Path:
    zips = sorted(dist.glob("qtvq-context-*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not zips:
        raise FileNotFoundError(f"No qtvq-context-*.zip in {dist}. Run build-context-bundle.ps1 first.")
    return zips[0]


def upload_obs(local: Path, env: dict[str, str]) -> str:
    try:
        from obs import ObsClient
    except ImportError:
        print("Install SDK: pip install esdk-obs-python", file=sys.stderr)
        sys.exit(1)

    ak = env.get("OBS_ACCESS_KEY_ID") or os.environ.get("OBS_ACCESS_KEY_ID")
    sk = env.get("OBS_SECRET_ACCESS_KEY") or os.environ.get("OBS_SECRET_ACCESS_KEY")
    endpoint = env.get("OBS_ENDPOINT") or os.environ.get("OBS_ENDPOINT")
    bucket = env.get("OBS_BUCKET") or os.environ.get("OBS_BUCKET")
    prefix = (env.get("OBS_PREFIX") or os.environ.get("OBS_PREFIX") or "qtvq/context/").rstrip("/") + "/"

    if not all([ak, sk, endpoint, bucket]):
        print("Missing OBS config. Copy obs.env.example to obs.env", file=sys.stderr)
        sys.exit(1)

    key = prefix + local.name
    client = ObsClient(access_key_id=ak, secret_access_key=sk, server=endpoint)
    try:
        resp = client.putFile(bucket, key, str(local))
        if getattr(resp, "status", 200) >= 300:
            raise RuntimeError(f"OBS upload failed: status={getattr(resp, 'status', '?')} body={resp}")
    finally:
        client.close()

    return f"{endpoint.replace('https://', '').split('/')[0]}/{bucket}/{key}"


def main() -> None:
    env_file = ROOT / "obs.env"
    env = {**load_env(env_file), **{k: v for k, v in os.environ.items() if k.startswith("OBS_")}}

    dist = ROOT / "dist"
    zip_path = Path(sys.argv[1]) if len(sys.argv) > 1 else pick_latest_zip(dist)
    if not zip_path.exists():
        print(f"File not found: {zip_path}", file=sys.stderr)
        sys.exit(1)

    uri = upload_obs(zip_path, env)
    print(f"Uploaded: {zip_path.name}")
    print(f"Object key: {uri}")


if __name__ == "__main__":
    main()
