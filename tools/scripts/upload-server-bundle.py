#!/usr/bin/env python3
"""Package `server/` + deploy helpers and publish them to OSS, then print a
time-limited signed URL.

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
import base64
import hashlib
import hmac
import io
import os
import sys
import tarfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVER_DIR = ROOT / "server"
DIST = ROOT / "dist"
BUNDLE_NAME = "qtvq-server.tgz"
DEFAULT_PREFIX = "qtvq/srv/"
EXCLUDE_PARTS = {"node_modules", ".git", "__pycache__", "dist", "coverage"}
EXCLUDE_FILES = {".env", "boot-out.txt", "boot-err.txt"}

# 除了 server/，还要带上静态同步依赖的文件：
# sync-static.sh 会调用同目录的 write-version.sh 与 copy-verify-root.sh，
# 只给 server/ 的话服务器上拿到的仍是那份有泄露缺陷的旧脚本。
EXTRA_PATHS = ["tools", ".assetsignore"]

# 文本类文件打进 Linux 包时必须转成 LF。
# 本仓库 core.autocrlf=true，工作区的 .sh 可能是 CRLF —— 原样打包的话，
# 服务器上会报 `line 4: $'\r': command not found`，而且只有部分脚本中招，极难排查。
TEXT_EXTS = {
    ".sh", ".mjs", ".js", ".json", ".md", ".html", ".css", ".txt",
    ".yml", ".yaml", ".toml", ".example", ".gitignore", ".gitattributes",
    ".ps1", ".py",
}
TEXT_NAMES = {
    "Dockerfile", "Makefile", ".env.example",
    ".gitignore", ".assetsignore", ".gitattributes",
}


def is_text_like(path: Path) -> bool:
    return path.name in TEXT_NAMES or path.suffix.lower() in TEXT_EXTS or path.name.startswith(".")


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


def presign_oss_v1(ak: str, sk: str, bucket: str, key: str, endpoint: str, expires: int = 86400) -> str:
    """自己算阿里云 OSS 的 V1 签名。

    为什么不用 SDK 的 `createSignedUrl`：这个环境的 SDK 是华为云 OBS 的
    `esdk-obs-python`（只是把 endpoint 指向了阿里云 OSS），它生成的查询参数是
    `AccessKeyId`，而**阿里云要求 `OSSAccessKeyId`** —— 参数名不对，OSS 视为缺少
    鉴权信息，直接 403。实测：`AccessKeyId` → 403，`OSSAccessKeyId` → 200。

    上传（putFile）用 SDK 没问题，只有签名 URL 需要自己算。
    """
    expires_at = int(time.time()) + int(expires)
    # V1 StringToSign: VERB\nContent-MD5\nContent-Type\nExpires\nCanonicalizedOSSHeaders\nCanonicalizedResource
    # GET 无 body、无自定义头，中间三段为空
    string_to_sign = f"GET\n\n\n{expires_at}\n/{bucket}/{key}"
    signature = base64.b64encode(
        hmac.new(sk.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha1).digest()
    ).decode("utf-8")
    return (
        f"https://{bucket}.{endpoint}/{key}"
        f"?Expires={expires_at}"
        f"&OSSAccessKeyId={urllib.parse.quote(ak, safe='')}"
        f"&Signature={urllib.parse.quote(signature, safe='')}"
    )


def verify_url(url: str) -> tuple[bool, str]:
    """发出链接前先自己下载一次：不要把没验证过的 URL 交给别人。"""
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return True, f"HTTP {resp.status}，{resp.headers.get('Content-Length')} 字节"
    except Exception as exc:  # noqa: BLE001
        return False, f"{getattr(exc, 'code', '?')} {exc}"


def add_tree(tar: tarfile.TarFile, base: Path, arc_prefix: str) -> None:
    """把 base 递归加入 tar，文本文件统一转 LF。

    不用 `tar.add(..., filter=)` 是因为 filter 只能改 TarInfo、改不了内容，
    而 CRLF 必须改内容 —— 见 is_text_like 的注释。
    """
    base = base.resolve()
    for path in sorted(base.rglob("*")):
        rel = path.relative_to(base)
        if any(part in EXCLUDE_PARTS for part in rel.parts):
            continue
        if path.name in EXCLUDE_FILES:
            continue
        arcname = f"{arc_prefix}/{rel.as_posix()}"
        info = tar.gettarinfo(str(path), arcname=arcname)
        if info.isdir():
            tar.addfile(info)
            continue
        if info.isreg() and is_text_like(path):
            data = path.read_bytes().replace(b"\r\n", b"\n")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
            continue
        if info.isreg():
            with open(path, "rb") as fh:
                tar.addfile(info, fh)
        else:
            tar.addfile(info)


def build_bundle() -> Path:
    DIST.mkdir(exist_ok=True)
    out = DIST / BUNDLE_NAME
    print(f">> 打包 {SERVER_DIR} + {' '.join(EXTRA_PATHS)} -> {out}")

    with tarfile.open(out, "w:gz") as tar:
        add_tree(tar, SERVER_DIR, "server")
        for rel in EXTRA_PATHS:
            p = ROOT / rel
            if p.is_dir():
                add_tree(tar, p, rel)
            elif p.is_file():
                info = tar.gettarinfo(str(p), arcname=rel)
                raw = p.read_bytes()
                data = raw.replace(b"\r\n", b"\n") if is_text_like(p) else raw
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            else:
                print(f"   跳过（不存在）：{rel}")

    size_kb = out.stat().st_size / 1024
    with tarfile.open(out, "r:gz") as tar:
        members = tar.getmembers()
        names = [m.name for m in members]
        # 打包后自证：shell 脚本里不许残留 CR
        shell_bad = []
        for m in members:
            if m.name.endswith(".sh"):
                fh = tar.extractfile(m)
                if fh and b"\r\n" in fh.read():
                    shell_bad.append(m.name)
    print(f"   文件数 {len(names)}，大小 {size_kb:.1f} KB")

    required = ["server/src/app.js", "tools/scripts/sync-static.sh"]
    missing = [r for r in required if not any(n.endswith(r) for n in names)]
    if missing:
        print(f"!! 打包内容异常：缺少 {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)
    if shell_bad:
        print(
            f"!! 以下 shell 脚本仍含 CRLF，到 Linux 会报 "
            f"$'\\r': command not found：{shell_bad}",
            file=sys.stderr,
        )
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
    finally:
        client.close()

    # 自己签名（SDK 生成的是华为 OBS 的 AccessKeyId，阿里云不认）并当场验证
    url = presign_oss_v1(ak, sk, bucket, key, endpoint, expires=args.expires)
    ok, detail = verify_url(url)
    if not ok:
        print(f"!! 生成的签名 URL 自检失败：{detail}", file=sys.stderr)
        print("   已中止，未把不可用链接交出去。请检查 AK/SK 是否有该桶的读权限。", file=sys.stderr)
        return 1
    print(f">> 签名 URL 自检通过：{detail}")

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
