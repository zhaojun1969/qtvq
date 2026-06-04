#!/usr/bin/env python3
"""Remote static sync via Aliyun ECS or SWAS RunCommand."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sys
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET_IP = "47.115.214.130"
REGIONS = ["cn-beijing", "cn-hangzhou", "cn-shanghai", "cn-qingdao", "cn-shenzhen", "cn-zhangjiakou"]


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


def sign_request(ak: str, sk: str, host: str, params: dict[str, str], version: str) -> str:
    base = {
        **params,
        "Format": "JSON",
        "Version": version,
        "AccessKeyId": ak,
        "SignatureMethod": "HMAC-SHA1",
        "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "SignatureVersion": "1.0",
        "SignatureNonce": str(uuid.uuid4()),
    }
    qs = "&".join(
        f"{urllib.parse.quote(k, safe='~')}={urllib.parse.quote(str(base[k]), safe='~')}"
        for k in sorted(base)
    )
    sts = f"GET&%2F&{urllib.parse.quote(qs, safe='~')}"
    sig = base64.b64encode(hmac.new(f"{sk}&".encode(), sts.encode(), hashlib.sha1).digest()).decode()
    return f"https://{host}/?{qs}&Signature={urllib.parse.quote(sig)}"


def aliyun_get(ak: str, sk: str, host: str, params: dict[str, str], version: str) -> dict:
    url = sign_request(ak, sk, host, params, version)
    with urllib.request.urlopen(url, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    if data.get("Code") and data.get("Code") not in ("200", "Success"):
        raise RuntimeError(f"{params.get('Action')}: {data.get('Message') or data}")
    return data


def build_cmd(ak: str, sk: str) -> str:
    return (
        "set -e; "
        "export DEBIAN_FRONTEND=noninteractive; "
        "command -v python3 >/dev/null || (apt-get update -qq && apt-get install -y -qq python3 python3-pip); "
        "python3 -m pip install -q esdk-obs-python 2>/dev/null || pip3 install -q esdk-obs-python; "
        "python3 -c \"from obs import ObsClient; "
        f"c=ObsClient(access_key_id='{ak}',secret_access_key='{sk}',server='oss-cn-beijing.aliyuncs.com'); "
        "c.getObject('qtvq','qtvq/context/qtvq-static.tgz',downloadPath='/tmp/qtvq-static.tgz'); c.close()\" "
        "&& sudo mkdir -p /var/www/qtvq "
        "&& sudo tar -xzf /tmp/qtvq-static.tgz -C /var/www/qtvq "
        "&& sudo chown -R www-data:www-data /var/www/qtvq "
        "&& rm -f /tmp/qtvq-static.tgz "
        "&& test -f /var/www/qtvq/js/voice-asr.js "
        "&& echo STATIC_SYNC_OK"
    )


def find_ecs(ak: str, sk: str) -> tuple[str, str] | None:
    for region in REGIONS:
        try:
            data = aliyun_get(
                ak, sk, f"ecs.{region}.aliyuncs.com",
                {"Action": "DescribeInstances", "RegionId": region, "PageSize": "100"},
                "2014-05-26",
            )
        except Exception as exc:
            print(f"ECS {region}: {exc}")
            continue
        for inst in data.get("Instances", {}).get("Instance", []):
            ips = inst.get("PublicIpAddress", {}).get("IpAddress") or []
            eip = inst.get("EipAddress", {}).get("IpAddress")
            if TARGET_IP in ips or TARGET_IP == eip:
                return ("ecs", region, inst["InstanceId"])
    return None


def find_swas(ak: str, sk: str) -> tuple[str, str, str] | None:
    for region in REGIONS:
        host = f"swas.{region}.aliyuncs.com"
        try:
            data = aliyun_get(
                ak, sk, host,
                {"Action": "ListInstances", "RegionId": region, "PageNumber": "1", "PageSize": "100"},
                "2020-06-01",
            )
        except Exception as exc:
            print(f"SWAS {region}: {exc}")
            continue
        for inst in data.get("Instances", []):
            ip = inst.get("PublicIpAddress") or inst.get("PublicIp")
            if ip == TARGET_IP:
                iid = inst.get("InstanceId") or inst.get("Id")
                return ("swas", region, iid)
    return None


def run_ecs(ak: str, sk: str, region: str, instance_id: str, cmd: str) -> int:
    host = f"ecs.{region}.aliyuncs.com"
    run = aliyun_get(
        ak, sk, host,
        {"Action": "RunCommand", "RegionId": region, "InstanceId.1": instance_id, "CommandContent": cmd, "Timeout": "180"},
        "2014-05-26",
    )
    return poll_ecs(ak, sk, region, run["InvokeId"])


def run_swas(ak: str, sk: str, region: str, instance_id: str, cmd: str) -> int:
    host = f"swas.{region}.aliyuncs.com"
    run = aliyun_get(
        ak, sk, host,
        {"Action": "RunCommand", "RegionId": region, "InstanceId": instance_id, "Command": cmd, "Timeout": "180"},
        "2020-06-01",
    )
    invoke_id = run.get("InvokeId") or run.get("InvocationId")
    for _ in range(30):
        time.sleep(4)
        try:
            inv = aliyun_get(
                ak, sk, host,
                {"Action": "DescribeInvocationResult", "RegionId": region, "InvokeId": invoke_id},
                "2020-06-01",
            )
        except Exception:
            inv = aliyun_get(
                ak, sk, host,
                {"Action": "DescribeInvocations", "RegionId": region, "InstanceId": instance_id},
                "2020-06-01",
            )
        output = json.dumps(inv, ensure_ascii=False)
        print(output[:2000])
        if "STATIC_SYNC_OK" in output:
            return 0
        if "Failed" in output or "Success" in output:
            break
    return 1


def poll_ecs(ak: str, sk: str, region: str, invoke_id: str) -> int:
    host = f"ecs.{region}.aliyuncs.com"
    for _ in range(30):
        time.sleep(4)
        inv = aliyun_get(
            ak, sk, host,
            {"Action": "DescribeInvocationResults", "RegionId": region, "InvokeId": invoke_id},
            "2014-05-26",
        )
        results = inv.get("Invocation", {}).get("InvocationResults", {}).get("InvocationResult", [])
        if not results:
            continue
        r = results[0]
        status = r.get("InvocationStatus")
        output = (r.get("Output") or "").strip()
        if output:
            try:
                output = base64.b64decode(output).decode("utf-8", errors="replace")
            except Exception:
                pass
        print(f"status={status}")
        if output:
            print(output[-3000:])
        if status in ("Success", "Failed", "Timeout", "Cancelled"):
            return 0 if status == "Success" and "STATIC_SYNC_OK" in output else 1
    return 1


def main() -> int:
    env = load_env(ROOT / "obs.env")
    ak, sk = env.get("OBS_ACCESS_KEY_ID", ""), env.get("OBS_SECRET_ACCESS_KEY", "")
    if not ak or not sk:
        print("Missing obs.env", file=sys.stderr)
        return 1

    cmd = build_cmd(ak, sk)
    hit = find_ecs(ak, sk) or find_swas(ak, sk)
    if not hit:
        print(f"No ECS/SWAS instance for {TARGET_IP}", file=sys.stderr)
        return 2

    kind, region, iid = hit
    print(f">> {kind.upper()} {region} {iid}")
    if kind == "ecs":
        return run_ecs(ak, sk, region, iid, cmd)
    return run_swas(ak, sk, region, iid, cmd)


if __name__ == "__main__":
    raise SystemExit(main())
