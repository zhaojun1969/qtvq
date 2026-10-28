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
        url = str(resp.signedUrl if hasattr(resp, "signedUrl") else resp)

        # 华为 OBS SDK 生成的查询参数名是 AccessKeyId，而阿里云 OSS 要求 OSSAccessKeyId。
        # 同一个坑早先在 upload-server-bundle.py 里踩过：参数名不对 → 403 InvalidAccessKeyId。
        url = url.replace("AccessKeyId=", "OSSAccessKeyId=")

        # 打印之前先自检：拿了 URL 却不能用，比不打印更糟（会让人以为只是命令写法问题）
        import urllib.request

        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                if r.status != 200:
                    print(f"自检失败：HTTP {r.status}", file=sys.stderr)
                    return 1
                magic = r.read(2)
                if magic != b"\x1f\x8b":
                    print("自检失败：下载到的内容不是 gzip（应为 tar.gz）", file=sys.stderr)
                    return 1
        except Exception as e:  # noqa: BLE001
            print(f"自检失败：{e}", file=sys.stderr)
            return 1

        # 直接给出**可整条粘贴**的命令，而不是裸 URL。
        # 教训（2026-09-17 实际发生）：给裸 URL 时对方很容易只写 `curl -sS -o`，
        # 一旦链接过期，OSS 会返回一段 XML 错误文档并被存成 .tgz，
        # tar 于是报 "gzip: stdin: not in gzip format" —— 完全指不出真正原因是"链接过期"。
        # 所以这里：① 用 curl -f（HTTP 错误即失败，链条会在解压前停住）；
        #          ② 校验 gzip 魔数；③ 才解压。任何一步失败都给出人能看懂的原因。
        print(url)
        print()
        print("在服务器上执行（一次一条；整条粘贴也可以）：")
        print()
        print(
            f"curl -fSL -o /tmp/qtvq-static.tgz '{url}' "
            f"&& head -c 2 /tmp/qtvq-static.tgz | od -An -tx1 | grep -q '1f 8b' "
            f"&& sudo tar -xzf /tmp/qtvq-static.tgz -C /var/www/qtvq "
            f"&& sudo chown -R www-data:www-data /var/www/qtvq "
            f"&& head -3 /var/www/qtvq/js/version.js "
            f"&& grep -c channelTip /var/www/qtvq/js/pay-qr.js "
            f"&& ls -l /var/www/qtvq/js/report-reason.js"
        )
        print()
        print("说明：若报 'Not Found' / 403，说明链接已过期，重新运行本脚本即可；")
        print("      若报 head 那一步失败，说明下载到的不是 tar.gz（同样多半是链接过期）。")
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
