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
# `js/` 也打进去：服务器脚本要复用浏览器端的纯 JS 实现（例如 buy-real-report.mjs
# 用 js/qr-render.js 的 qrMatrix 画二维码）。不打包的话 /opt/qtvq/js 会停在几个月前
# 的旧副本上 —— 实测是一份 322 字节的 stub，import 进来 `qrMatrix is not a function`。
EXTRA_PATHS = ["tools", "packages", "js", ".assetsignore"]

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


def source_fingerprint() -> tuple[str, int]:
    """算出 `server/src` 的构建指纹（与服务端 build-info.js、tools/scripts/server-build-sha.mjs 同算法）。

    为什么发布脚本也要算：交付命令里必须带上**预期值**，否则"部署完了吗"只能靠人眼比对；
    而且两边独立实现算出同一个值，本身就是对算法正确性的交叉验证（2026-09-18 已用 JS 两处实现互验过）。

    算法（三处必须完全一致）：server/src 下所有文件按相对 POSIX 路径排序，
    对每个文件依次 update(路径) + "\\0" + update(内容) + "\\0"，最后取 sha256 前 16 位十六进制。
    """
    root = SERVER_DIR / "src"
    rels: list[str] = []
    for path in root.rglob("*"):
        rel = path.relative_to(root)
        if any(part in EXCLUDE_PARTS for part in rel.parts):
            continue
        if path.is_file():
            rels.append(rel.as_posix())
    rels.sort()
    h = hashlib.sha256()
    for rel in rels:
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        # 行尾归一化（CRLF→LF）后再哈希，与 add_tree() 打包时的转换保持一致。
        # 线上 build-info.js 算的是**转换后**部署上去的字节；若这里对原始字节哈希，
        # 工作区里带 CRLF 的文件（core.autocrlf=true 下很常见）会永远与线上不一致，
        # 看起来就像"部署没生效" —— 2026-10-11 在 server/src/lib/aliyun-nls.js 上实测过。
        # 三处实现必须一致：本函数、server/src/lib/build-info.js、tools/scripts/server-build-sha.mjs。
        h.update((root / rel).read_bytes().replace(b"\r\n", b"\n"))
        h.update(b"\0")
    return h.hexdigest()[:16], len(rels)


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
    fp, fp_files = source_fingerprint()

    # SSH 目标从 cf.env 读（与 sync-static-from-windows.ps1 同一套配置）
    cf = load_env(ROOT / "cf.env")
    ssh_host = os.environ.get("QTVQ_SSH_HOST") or cf.get("QTVQ_SSH_HOST") or "<你的服务器IP>"
    ssh_user = os.environ.get("QTVQ_SSH_USER") or cf.get("QTVQ_SSH_USER") or "root"
    ssh_prefix = f'ssh -i "$env:USERPROFILE\\.ssh\\id_ed25519" {ssh_user}@{ssh_host}'

    print()
    print("=" * 72)
    print(f"签名 URL（{hours:.1f} 小时内有效，请勿外传）：")
    print(url)
    print("=" * 72)
    print()
    print(f"本次代码指纹（server/src，{fp_files} 个文件）：{fp}")
    print("部署成功的判据 = 命令最后打印出的 sha 与它相同。")
    print()

    # ------------------------------------------------------------------
    # 为什么把命令写成"经 ssh 执行的一条"：
    # 2026-09-20 连续两次部署没生效，两个原因各踩一次 ——
    #   ① 多行命令被部分粘贴 → 只下载、没解压，而"下载成功"的输出让人以为做完了；
    #   ② 命令被粘进 **Windows PowerShell**：PowerShell 5.1 不支持 `&&`，
    #      整条直接解析失败（报"&&不是此版本中的有效语句分隔符"），一条都没执行。
    # 所以现在默认输出**PowerShell 可直接粘贴**的形态：外层是 ssh，`&&` 在引号里由
    # 服务器上的 bash 解析；并自带判据（从 127.0.0.1 读指纹，绕过 nginx 与缓存）。
    # ------------------------------------------------------------------
    print("-" * 72)
    print("【方式一 · 推荐】在 Windows PowerShell 里直接粘这一条（经 SSH 到服务器执行）")
    print("-" * 72)
    print(
        f"{ssh_prefix} "
        f"\"cd /opt/qtvq && curl -fSL -o /tmp/{BUNDLE_NAME} '{url}' "
        f"&& head -c 2 /tmp/{BUNDLE_NAME} | od -An -tx1 | grep -q 1f "
        f"&& sudo tar -xzf /tmp/{BUNDLE_NAME} -C /opt/qtvq && rm -f /tmp/{BUNDLE_NAME} "
        f"&& sudo systemctl restart qtvq-report && sleep 3 && systemctl is-active qtvq-report "
        f"&& curl -sS http://127.0.0.1:3000/v1/health | grep -o .sha.:.[a-f0-9]*.\""
    )
    print()
    print("  · PowerShell 里 `&&` 不是语句分隔符（5.1 会直接报错），所以整条交给服务器的 bash；")
    print("    引号内的 && 不经过 PowerShell 解析。")
    print("  · 若提示输入密码就输入服务器密码；若报 Permission denied，改用方式二。")
    print()
    print("-" * 72)
    print("【方式二】先登录服务器（或已经在服务器上），再粘下面这一条")
    print("-" * 72)
    print(ssh_prefix)
    print()
    print(
        f"cd /opt/qtvq && curl -fSL -o /tmp/{BUNDLE_NAME} '{url}' "
        f"&& head -c 2 /tmp/{BUNDLE_NAME} | od -An -tx1 | grep -q '1f 8b' "
        f"&& sudo tar -xzf /tmp/{BUNDLE_NAME} -C /opt/qtvq && rm -f /tmp/{BUNDLE_NAME} "
        f"&& sudo systemctl restart qtvq-report && sleep 3 && systemctl is-active qtvq-report "
        f"&& curl -sS 'http://127.0.0.1:3000/v1/health' | grep -o '\"sha\":\"[a-f0-9]*\"'"
    )
    print()
    print(f"  期望最后一行是： \"sha\":\"{fp}\"（前面还有 active）")
    print("  什么都不输出 → 下载或魔数校验失败（多半是链接过期）；")
    print("  只到 active 没有 sha → 服务起来了但指纹读不到；")
    print("  sha 是别的值 → 代码没被替换（解压没执行）。")
    print()
    print("-" * 72)
    print("【诊断】若怀疑上次只跑了一半，先跑这条只读命令（不做任何改动）")
    print("-" * 72)
    print(
        f"{ssh_prefix} "
        f"\"ls -l --time-style=long-iso /opt/qtvq/server/src/config/env.js; "
        f"systemctl show qtvq-report -p ActiveEnterTimestamp; "
        f"curl -sS http://127.0.0.1:3000/v1/health | grep -o .sha.:.[a-f0-9]*.\""
    )
    print("  判读：env.js 修改时间是「刚才」但 sha 没变 → 只差重启；")
    print("        修改时间还是旧的 → 解压没执行（命令没真正到服务器）。")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
