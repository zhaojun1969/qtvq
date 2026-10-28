#!/usr/bin/env bash
# Q问 · 站点滥用告警（装到 /opt/qtvq/tools/alerts/check-nginx-abuse.sh，由 cron 每 5 分钟跑一次）
#
# 作用：统计最近 N 分钟内的 429/444 与蜜罐命中，超过阈值就发告警邮件。
#
# 为什么需要它：fail2ban 只负责"封单个 IP"，它看不见**整体趋势**。
# 饱和攻击的典型特征是"大量不同 IP、每个都只试探几次" —— 单个 IP 达不到封禁阈值，
# 总量却已经打满带宽与连接数。这种只能靠**总量统计**发现。
#
# 为什么改成"本机直连 SMTP"（2026-10-11 变更，别再改回去）：
#   原来是调用 `POST /api/ops/alert`（X-Admin-Key 保护）复用 Cloudflare Pages 的那条邮件链路。
#   但那意味着**告警本身依赖跨海链路** —— 当天实测 `/api/*` 间歇挂死到 60s，
#   而"链路出问题"恰恰是最需要告警的时刻，那时告警反而发不出去（自相矛盾）。
#   实测本机可直连 `smtps://smtp.qiye.aliyun.com:465`（curl `response_code=250`），
#   凭据放 `/etc/qtvq-alert.env`（600 root）。HTTP 接口保留为**兜底**，直连失败才走。
#   另：本机**没有** mail/msmtp/sendmail，务必用 curl 的 SMTP 能力（`--ssl-reqd` + `--upload-file`）。
#
# 安装时会写入的环境变量文件：/opt/qtvq/tools/alerts/alert.env（含 ADMIN_KEY，权限 600）
#   QTVQ_OPS_KEY=...           # 告警接口密钥（Pages 的 OPS_ALERT_KEY 或 PAYMENT_ADMIN_KEY）
#   QTVQ_ALERT_URL=https://qtvq.cn/api/ops/alert
#   QTVQ_ALERT_TO_LOG=/var/log/qtvq-alerts.log

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/alert.env"
# shellcheck source=/dev/null
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

ALERT_URL="${QTVQ_ALERT_URL:-https://qtvq.cn/api/ops/alert}"
OPS_KEY="${QTVQ_OPS_KEY:-}"
ALERT_LOG="${QTVQ_ALERT_TO_LOG:-/var/log/qtvq-alerts.log}"
STATE_FILE="${SCRIPT_DIR}/.last-alert"
# 冷静期：同一类告警 30 分钟内不重复发（否则每 5 分钟一封邮件，运营会直接忽略邮件）
COOLDOWN_SEC=1800
# 统计窗口
WINDOW_MIN=5
# 阈值：这两个数是"明显异常但正常波动不会达到"的量级
THRESHOLD_429=60
THRESHOLD_444=40
THRESHOLD_HONEYPOT=10

ACCESS_LOG=/var/log/nginx/access.log
ABUSE_LOG=/var/log/nginx/qtvq-abuse.log

count_recent() {
  # $1=文件 $2=正则。文件可能不存在（例如 abuse 日志尚未产生）
  local file="$1" pat="$2"
  [ -f "$file" ] || { echo 0; return; }
  # 用时间窗口过滤：直接看文件尾部 N 行，避免解析时间戳（快且够用）
  tail -n 5000 "$file" 2>/dev/null | grep -cE "$pat" || true
}

# 只统计"最近 5 分钟"：拿每 5 分钟跑一次这个前提，用 last-N-minutes 的 time 字符串过滤
SINCE="$(date -d "-${WINDOW_MIN} minutes" '+%d/%b/%Y:%H:%M' 2>/dev/null || echo '')"
count_window() {
  local file="$1" pat="$2"
  [ -f "$file" ] || { echo 0; return; }
  if [ -n "$SINCE" ]; then
    # 用 awk 精确按时间戳窗口统计（跨小时也正确）
    awk -v since="$SINCE" '
      {
        # 形如 [11/Oct/2026:04:28:35 +0800]
        if (match($0, /\[[0-9]{2}\/[A-Za-z]{3}\/[0-9]{4}:[0-9]{2}:[0-9]{2}/)) {
          ts = substr($0, RSTART + 1, RLENGTH - 1)
          # 比较到分钟即可（字符串比较对 dd/Mon/yyyy:HH:MM 不成立，故转成可比数值）
          split(ts, a, /[\/:]/)
          mon = a[2]
          m["Jan"]=1; m["Feb"]=2; m["Mar"]=3; m["Apr"]=4; m["May"]=5; m["Jun"]=6
          m["Jul"]=7; m["Aug"]=8; m["Sep"]=9; m["Oct"]=10; m["Nov"]=11; m["Dec"]=12
          key = a[3]*100000000 + m[mon]*1000000 + a[4]*10000 + a[5]*100
          split(since, b, /[\/:]/)
          skey = b[3]*100000000 + m[b[2]]*1000000 + b[4]*10000 + b[5]*100
          if (key >= skey && $0 ~ pat) c++
        }
      }
      END { print c + 0 }
    ' pat="$pat" "$file"
  else
    count_recent "$file" "$pat"
  fi
}

C429=$(count_window "$ACCESS_LOG" ' (429) ')
C444=$(count_window "$ACCESS_LOG" ' (444) ')
HONEY=$(count_window "$ABUSE_LOG" 'honeypot=1')
BADUA=$(count_window "$ABUSE_LOG" 'ua_bad=1')
FAKE=$(count_window "$ABUSE_LOG" 'fake_crawler=1')
BANNED=$(fail2ban-client status qtvq-nginx 2>/dev/null | awk -F'\t' '/Currently banned/{print $2}' || echo '?')

TRIGGER=""
[ "$C429" -ge "$THRESHOLD_429" ] && TRIGGER="${TRIGGER}429突增($C429) "
[ "$C444" -ge "$THRESHOLD_444" ] && TRIGGER="${TRIGGER}444突增($C444) "
[ "$HONEY" -ge "$THRESHOLD_HONEYPOT" ] && TRIGGER="${TRIGGER}蜜罐命中($HONEY) "

# 每次运行都记一行到本地日志（即使没触发）—— 事后排查"什么时候开始异常的"全靠它
mkdir -p "$(dirname "$ALERT_LOG")" 2>/dev/null || true
printf '%s 429=%s 444=%s honeypot=%s bad_ua=%s fake_crawler=%s banned=%s %s\n' \
  "$(date -Is)" "$C429" "$C444" "$HONEY" "$BADUA" "$FAKE" "$BANNED" "${TRIGGER:-ok}" >> "$ALERT_LOG" 2>/dev/null || true

if [ -z "$TRIGGER" ]; then
  exit 0
fi

# 冷静期检查
NOW=$(date +%s)
if [ -f "$STATE_FILE" ]; then
  LAST=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -lt "$COOLDOWN_SEC" ]; then
    exit 0
  fi
fi
echo "$NOW" > "$STATE_FILE"

TEXT=$(printf '最近 %s 分钟：429=%s 444=%s；蜜罐命中=%s 恶意UA=%s 伪装爬虫=%s；fail2ban 当前封禁=%s\n\n触发：%s\n日志：/var/log/nginx/qtvq-abuse.log\n查看封禁：sudo fail2ban-client status qtvq-nginx' \
  "$WINDOW_MIN" "$C429" "$C444" "$HONEY" "$BADUA" "$FAKE" "$BANNED" "$TRIGGER")

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

SUBJECT="[Q问告警] $(printf '%s' "$TRIGGER" | head -c 80)"

# ── 发送路径一（首选）：直连 SMTP，不经过 Cloudflare ─────────────────────────
# 为什么改成首选：原实现把告警经 `/api/ops/alert` 送到 Cloudflare Pages 再发信，
# 而 Cloudflare 这条链路本身就会挂（2026-10-11 实测 `/api/*` 间歇挂死到 60s）——
# 偏偏"链路出问题"正是最需要告警的时刻，那时告警反而发不出去。
# 实测本机可直连 `smtps://smtp.qiye.aliyun.com:465`（curl `response_code=250`）。
# 凭据在 /etc/qtvq-alert.env（600 root，由安装时写入）。
SMTP_ENV=/etc/qtvq-alert.env
# shellcheck disable=SC1090
[ -r "$SMTP_ENV" ] && . "$SMTP_ENV"

send_direct_smtp() {
  [ -n "$SMTP_HOST" ] && [ -n "$SMTP_USER" ] && [ -n "$SMTP_PASS" ] || return 1
  local scheme=smtp
  [ "$SMTP_SECURE" = "true" ] && scheme=smtps
  printf 'From: %s\nTo: %s\nSubject: %s\nContent-Type: text/plain; charset=UTF-8\n\n%s\n' \
    "$SMTP_FROM" "$SMTP_TO" "$SUBJECT" "$TEXT" > "$TMP"
  curl -sS --max-time 30 --url "$scheme://$SMTP_HOST:$SMTP_PORT" --ssl-reqd \
    --mail-from "$SMTP_FROM" --mail-rcpt "$SMTP_TO" \
    --user "$SMTP_USER:$SMTP_PASS" --upload-file "$TMP" \
    -o /dev/null -w '%{response_code}' 2>/dev/null
}

SMTP_CODE=$(send_direct_smtp || echo 000)
if [ "$SMTP_CODE" = "250" ]; then
  echo "[$(date -Is)] 已直连 SMTP 发出 code=$SMTP_CODE 触发=$TRIGGER" >> "$ALERT_LOG"
  exit 0
fi

# ── 发送路径二（兜底）：HTTP 接口 ───────────────────────────────────────────
# 直连失败才走这里（例如凭据过期、465 被运营商拦）。两条都失败时日志会同时留下两个码，
# 便于区分"是 SMTP 不通"还是"是 Cloudflare 不通"。
if [ -z "$OPS_KEY" ]; then
  echo "[$(date -Is)] 直连 SMTP 失败(code=$SMTP_CODE)，且未配置 QTVQ_OPS_KEY，告警未发出：$TRIGGER" >> "$ALERT_LOG"
  exit 0
fi

# 用 --data-binary + 文件写正文，避免中文与引号在 shell 里被拆坏（本项目踩过编码坑）
# 用 python3 生成 JSON，保证转义正确（服务器有 python3）
python3 - "$TMP" "$TRIGGER" "$TEXT" <<'PY'
import json, sys
out, subject, text = sys.argv[1], sys.argv[2], sys.argv[3]
with open(out, 'w', encoding='utf-8') as f:
    json.dump({'subject': f'[Q问告警] {subject.strip()}', 'text': text}, f, ensure_ascii=False)
PY

HTTP=$(curl -sS -o /tmp/qtvq-alert-resp.$$ -w '%{http_code}' --max-time 20 \
  -X POST "$ALERT_URL" \
  -H 'Content-Type: application/json' \
  -H "X-Admin-Key: $OPS_KEY" \
  --data-binary "@$TMP" 2>/dev/null || echo 000)

echo "[$(date -Is)] 直连 SMTP 失败(code=$SMTP_CODE)，已回退 HTTP 接口 HTTP=$HTTP 触发=$TRIGGER" >> "$ALERT_LOG"
rm -f "/tmp/qtvq-alert-resp.$$"
