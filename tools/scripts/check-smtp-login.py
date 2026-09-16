#!/usr/bin/env python3
"""
校验 .dev.vars 里的 SMTP 凭据能否真正登录（发信失败时先用它定位）。

为什么需要它：/api/health 的 mailConfigured 只检查"变量是否非空"，
密码错了它照样显示 true；而线上发信失败只回一句"邮件发送失败"，看不到真实报错。
本脚本在本地直连 SMTP 服务器，把真实的认证结果打出来（不打印密码）。

用法：
    python tools/scripts/check-smtp-login.py
"""
import pathlib
import re
import smtplib
import ssl
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".dev.vars"

if not ENV_FILE.exists():
    print("ERROR: 找不到 " + str(ENV_FILE))
    sys.exit(1)

env = {}
for m in re.finditer(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", ENV_FILE.read_text(encoding="utf-8"), re.M):
    env[m.group(1)] = m.group(2).strip()

host = env.get("SMTP_HOST", "").strip()
user = env.get("SMTP_USER", "").strip()
pwd = env.get("SMTP_PASS", "")
port = int(env.get("SMTP_PORT", "465") or 465)
secure = str(env.get("SMTP_SECURE", "true")).lower() != "false"

if not host or not user or not pwd:
    print("ERROR: SMTP_HOST / SMTP_USER / SMTP_PASS 有缺项（SMTP_PASS 是否为空？）")
    print("  host=%r user=%r pass_len=%d" % (host, user, len(pwd)))
    sys.exit(1)

print("SMTP: host=%s port=%d ssl=%s user=%s pass_len=%d" % (host, port, secure, user, len(pwd)))
# 打印机密值的字符类别（不打印内容），便于发现"粘进来多余字符"这类问题
kinds = set()
for ch in pwd:
    kinds.add("space" if ch.isspace() else ("alnum" if ch.isalnum() else "symbol"))
print("  密码字符类别: " + ", ".join(sorted(kinds)))

try:
    if port == 465 or secure:
        server = smtplib.SMTP_SSL(host, port, timeout=25, context=ssl.create_default_context())
    else:
        server = smtplib.SMTP(host, port, timeout=25)
        server.starttls(context=ssl.create_default_context())
    code, msg = server.login(user, pwd)
    detail = msg.decode(errors="replace") if isinstance(msg, bytes) else msg
    print("  ✅ 登录成功: %s %s" % (code, detail))
    server.quit()
    print("  → 凭据可用；可以推送：npm run mail:secrets 然后 npm run deploy")
except smtplib.SMTPAuthenticationError as e:
    detail = e.smtp_error.decode(errors="replace") if isinstance(e.smtp_error, bytes) else e.smtp_error
    print("  ❌ 认证失败: %s %s" % (e.smtp_code, detail))
    print("  → 密码不对。到邮箱服务商后台重新生成客户端密码/授权码，再填进 .dev.vars 的 SMTP_PASS=")
    sys.exit(2)
except Exception as e:
    print("  ❌ 连接或协议错误: %s %s" % (type(e).__name__, str(e)[:200]))
    sys.exit(3)
