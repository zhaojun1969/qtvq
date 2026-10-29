#!/usr/bin/env bash
# Q问 · 安全加固一键安装（nginx 防护 + fail2ban + 滥用告警）
#
# 设计原则（每一条都是为了避免"安全措施把线上搞挂"）：
#   1. **先备份再改**：所有被改的文件备份到 /root/qtvq-hardening-backup-<时间戳>/
#   2. **改完先 nginx -t**：测试不通过就**自动回滚**并退出非 0，绝不 reload 一个坏配置
#   3. **幂等**：重复执行不会重复插入片段（靠标记注释判断）
#   4. **不封 SSH**：fail2ban 只作用于 http/https（本项目用 SSH 部署，封了会把自己锁在门外）
#   5. **可验证**：跑完打印一组自测命令与预期结果
#
# 用法（在服务器上，用 sudo）：
#   sudo bash install.sh --ops-key '<PAYMENT_ADMIN_KEY 或 OPS_ALERT_KEY>'
#   sudo bash install.sh --ops-key '...' --no-fail2ban     # 只做 nginx 与告警
#   sudo bash install.sh --ops-key '...' --smtp-env /root/smtp.env   # 首次装机时带上 SMTP 凭据
#
# 站点配置文件路径可通过 --site 指定（默认 /etc/nginx/sites-enabled/qtvq）
#
# 关于 --smtp-env（**很重要，别忽略**）：
#   滥用告警**首选直连 SMTP**（`/etc/qtvq-alert.env`，600 root），因为它不能依赖跨海链路 ——
#   2026-10-11 实测 `/api/*` 会间歇挂死到 60s，而"链路出问题"正是最需要告警的时刻。
#   该文件里是邮件凭据（SMTP_HOST/PORT/SECURE/USER/PASS/FROM/TO），**不可能放进仓库**，
#   所以：**已存在就保留**（重装不会覆盖，也不会丢）；只有不存在且传了 `--smtp-env` 才写入。
#   两个都没有时会**明确警告**并退回 HTTP 接口（此时告警可用性重新依赖 Cloudflare）。

set -euo pipefail

SITE_CONF=/etc/nginx/sites-enabled/qtvq
SCRIPT_NAME="$(basename "$0")"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_KEY=""
DO_FAIL2BAN=1
SMTP_ENV_SRC=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ops-key) OPS_KEY="${2:-}"; shift 2 ;;
    --site) SITE_CONF="${2:-}"; shift 2 ;;
    --smtp-env) SMTP_ENV_SRC="${2:-}"; shift 2 ;;
    --no-fail2ban) DO_FAIL2BAN=0; shift ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: 需要 root（sudo bash $SCRIPT_NAME --ops-key '...'）" >&2
  exit 1
fi

if [ ! -f "$SITE_CONF" ]; then
  echo "ERROR: 找不到站点配置 $SITE_CONF（用 --site 指定）" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/qtvq-hardening-backup-$STAMP"
mkdir -p "$BACKUP"
echo ">> 备份到 $BACKUP"
cp -a "$SITE_CONF" "$BACKUP/" 2>/dev/null || true
cp -a /etc/nginx/nginx.conf "$BACKUP/" 2>/dev/null || true
[ -f /etc/nginx/conf.d/qtvq-security.conf ] && cp -a /etc/nginx/conf.d/qtvq-security.conf "$BACKUP/" || true
[ -f /etc/nginx/conf.d/qtvq-crawlers.geo.conf ] && cp -a /etc/nginx/conf.d/qtvq-crawlers.geo.conf "$BACKUP/" || true
[ -f /etc/nginx/conf.d/qtvq-api-edge.conf ] && cp -a /etc/nginx/conf.d/qtvq-api-edge.conf "$BACKUP/" || true

# ─────────────────────────── 1. nginx 防护 ───────────────────────────
echo ">> 安装 nginx 防护配置"
install -m 644 "$SRC_DIR/nginx/qtvq-security.conf" /etc/nginx/conf.d/qtvq-security.conf

# 封禁名单 map（2026-10-26）：让被 fail2ban 封禁的 IP 收到明确 429，而不是 DROP 造成的超时。
# 依赖 /etc/nginx/blacklisted-sessions.map —— 先建空文件，否则 nginx -t 会因 include 缺失而失败。
touch /etc/nginx/blacklisted-sessions.map
chmod 644 /etc/nginx/blacklisted-sessions.map
install -m 644 "$SRC_DIR/nginx/qtvq-blockmap.conf" /etc/nginx/conf.d/qtvq-blockmap.conf

# 静态资源缓存策略：按 `?v=<hash>` 指纹分流（带指纹 → 长缓存 immutable；不带 → 每次校验）
install -m 644 "$SRC_DIR/nginx/qtvq-cache.conf" /etc/nginx/conf.d/qtvq-cache.conf

# E2E 测试 UA 白名单：**已存在则保留服务器版本** —— 里面含令牌，覆盖会让端到端测试突然 444。
# 仓库模板只有 `default 0`（全拒），首次安装安全；令牌由运维按模板注释里的命令追加。
if [ -f /etc/nginx/conf.d/qtvq-e2e-ua.conf ]; then
  echo "   已存在 qtvq-e2e-ua.conf —— 保留服务器版本（含 E2E 令牌）"
else
  install -m 640 "$SRC_DIR/nginx/qtvq-e2e-ua.conf" /etc/nginx/conf.d/qtvq-e2e-ua.conf
fi

# 定时把 fail2ban 的封禁名单同步进上面那个 map（脚本 + systemd timer）
install -m 755 "$SRC_DIR/bin/qtvq-blocklist-sync" /usr/local/bin/qtvq-blocklist-sync
install -m 755 "$SRC_DIR/bin/qtvq-abuse-report" /usr/local/bin/qtvq-abuse-report
install -m 644 "$SRC_DIR/systemd/qtvq-blocklist-sync.service" /etc/systemd/system/qtvq-blocklist-sync.service
install -m 644 "$SRC_DIR/systemd/qtvq-blocklist-sync.timer" /etc/systemd/system/qtvq-blocklist-sync.timer
systemctl daemon-reload >/dev/null 2>&1 || true
systemctl enable --now qtvq-blocklist-sync.timer >/dev/null 2>&1 || true
echo "   封禁名单同步定时器：$(systemctl is-active qtvq-blocklist-sync.timer 2>/dev/null || echo 未启用)"

# 增长指标每日聚合（P4）：`events_YYYYMM` → `metrics_daily`。
# 只用系统 node + 仓库里的脚本，不引入新的运行时依赖；聚合本身幂等（按天 upsert）。
install -m 755 "$SRC_DIR/bin/qtvq-metrics-aggregate" /usr/local/bin/qtvq-metrics-aggregate
install -m 644 "$SRC_DIR/systemd/qtvq-metrics.service" /etc/systemd/system/qtvq-metrics.service
install -m 644 "$SRC_DIR/systemd/qtvq-metrics.timer" /etc/systemd/system/qtvq-metrics.timer
systemctl daemon-reload >/dev/null 2>&1 || true
systemctl enable --now qtvq-metrics.timer >/dev/null 2>&1 || true
echo "   指标聚合定时器：$(systemctl is-active qtvq-metrics.timer 2>/dev/null || echo 未启用)"

# 微信支付订单对账（2026-10-29）：回调是"尽力而为"，丢了就没有第二次。
# 实测事故：notify_url 指着 Pages 的 /api/ 路径，Node 侧永远收不到回调，
# 用户付了钱、本地订单一直 created。这里每 10 分钟拿待付订单去问微信，SUCCESS 就补成 paid。
install -m 644 "$SRC_DIR/systemd/qtvq-reconcile.service" /etc/systemd/system/qtvq-reconcile.service
install -m 644 "$SRC_DIR/systemd/qtvq-reconcile.timer" /etc/systemd/system/qtvq-reconcile.timer
systemctl daemon-reload >/dev/null 2>&1 || true
systemctl enable --now qtvq-reconcile.timer >/dev/null 2>&1 || true
echo "   支付对账定时器：$(systemctl is-active qtvq-reconcile.timer 2>/dev/null || echo 未启用)"

# 退款对账（2026-10-29）：微信退款是异步的，受理成功不等于到账；
# 没有这个任务，refundStatus 会永远停在 PROCESSING。
install -m 644 "$SRC_DIR/systemd/qtvq-refund-reconcile.service" /etc/systemd/system/qtvq-refund-reconcile.service
install -m 644 "$SRC_DIR/systemd/qtvq-refund-reconcile.timer" /etc/systemd/system/qtvq-refund-reconcile.timer
systemctl daemon-reload >/dev/null 2>&1 || true
systemctl enable --now qtvq-refund-reconcile.timer >/dev/null 2>&1 || true
echo "   退款对账定时器：$(systemctl is-active qtvq-refund-reconcile.timer 2>/dev/null || echo 未启用)"

# Cloudflare 边缘 IP 池（`/api/` 反代用）。
# 为什么必须装：`qtvq-api.pages.dev` 的 DNS 只返回 172.66.44.129 / 172.66.47.127，
# 而这两个 IP 从本站 ECS 出发 **ICMP 通但 HTTPS 被阻断**（实测 HTTP 000 超时），
# 症状是 `/api/*` 间歇挂死到 60s、nginx 返回 HTML 错误页、前端 JSON 解析崩溃。
# 因此把 `/api/` 指向自维护的"已验证可达"边缘 IP 池（Cloudflare 任意播，任意合法边缘 IP 都能服务本 zone）。
# **幂等：已存在则保留服务器版本**（运维可能按实测结果调整过 IP 列表）。
if [ -f /etc/nginx/conf.d/qtvq-api-edge.conf ]; then
  echo "   已存在 qtvq-api-edge.conf —— 保留服务器上的版本（IP 列表以线上实测为准）"
else
  install -m 644 "$SRC_DIR/nginx/qtvq-api-edge.conf" /etc/nginx/conf.d/qtvq-api-edge.conf
fi

# 爬虫白名单：**不要把示例名单覆盖掉已同步的正式名单**
if [ -f /etc/nginx/conf.d/qtvq-crawlers.geo.conf ]; then
  echo "   已存在 qtvq-crawlers.geo.conf —— 保留服务器上的版本（可能已用同步脚本更新过）"
else
  install -m 644 "$SRC_DIR/nginx/qtvq-crawlers.geo.conf" /etc/nginx/conf.d/qtvq-crawlers.geo.conf
fi

# 插入 server 片段（幂等：靠标记注释判断是否已插入）
MARK="# ===== QTVQ HARDENING (managed by deploy/hardening/install.sh) ====="
if grep -qF "$MARK" "$SITE_CONF"; then
  echo "   server 片段已存在，跳过插入"
else
  echo "   插入 server 片段（在首个 location 之前）"
  python3 - "$SITE_CONF" "$SRC_DIR/nginx/qtvq-server-snippet.conf" "$MARK" <<'PY'
import sys, io
site, snippet, mark = sys.argv[1], sys.argv[2], sys.argv[3]
with io.open(site, encoding='utf-8') as f:
    lines = f.readlines()
with io.open(snippet, encoding='utf-8') as f:
    body = f.read()
block = f"\n    {mark}\n" + "\n".join("    " + l.rstrip("\n") for l in body.splitlines()) + f"\n    # ===== QTVQ HARDENING END =====\n\n"
# 插到第一个 'location / {' 之前；找不到就插到第一个 server 块的 '{' 之后
idx = None
for i, l in enumerate(lines):
    if l.strip().startswith('location / {'):
        idx = i
        break
if idx is None:
    for i, l in enumerate(lines):
        if l.rstrip().endswith('{') and 'server' in lines[max(0,i-1)]:
            idx = i + 1
            break
if idx is None:
    sys.exit('找不到插入位置：站点配置结构与预期不符，请手工插入 server 片段')
lines.insert(idx, block)
with io.open(site, 'w', encoding='utf-8') as f:
    f.writelines(lines)
print('   已插入，位置第 %d 行' % (idx + 1))
PY
fi

# 隐藏版本号（全局）
if ! grep -qE '^\s*server_tokens\s+off;' /etc/nginx/nginx.conf; then
  sed -i 's/# server_tokens off;/server_tokens off;/' /etc/nginx/nginx.conf
  echo "   nginx.conf：已开启 server_tokens off"
fi

# ✅ 关键：测试不通过就回滚，绝不 reload
echo ">> nginx -t 校验"
if ! nginx -t 2>&1 | tee /tmp/qtvq-nginx-test.log; then
  echo "!! 配置测试失败，正在回滚" >&2
  cp -a "$BACKUP/$(basename "$SITE_CONF")" "$SITE_CONF"
  [ -f "$BACKUP/qtvq-security.conf" ] && cp -a "$BACKUP/qtvq-security.conf" /etc/nginx/conf.d/qtvq-security.conf || rm -f /etc/nginx/conf.d/qtvq-security.conf
[ -f "$BACKUP/qtvq-api-edge.conf" ] && cp -a "$BACKUP/qtvq-api-edge.conf" /etc/nginx/conf.d/qtvq-api-edge.conf || rm -f /etc/nginx/conf.d/qtvq-api-edge.conf
  nginx -t || true
  echo "!! 已回滚。请把上面 nginx -t 的输出发给技术方。" >&2
  exit 1
fi

# 日志文件需要先创建，否则 nginx 起不来
touch /var/log/nginx/qtvq-abuse.log
chown www-data:adm /var/log/nginx/qtvq-abuse.log
chmod 640 /var/log/nginx/qtvq-abuse.log

systemctl reload nginx
echo "   ✅ nginx 已 reload"

# ─────────────────────────── 2. fail2ban ───────────────────────────
if [ "$DO_FAIL2BAN" = "1" ]; then
  if ! command -v fail2ban-client >/dev/null 2>&1; then
    echo ">> 安装 fail2ban"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban
  else
    echo ">> fail2ban 已安装"
  fi

  install -m 644 "$SRC_DIR/fail2ban/filter.d/qtvq-nginx.conf" /etc/fail2ban/filter.d/qtvq-nginx.conf
  # 蜜罐专用 filter（2026-10-26 拆分）：不含 429，避免把限流当攻击。
  # 少了这一行，qtvq-honeypot jail 会因找不到 filter 而启动失败。
  install -m 644 "$SRC_DIR/fail2ban/filter.d/qtvq-honeypot.conf" /etc/fail2ban/filter.d/qtvq-honeypot.conf
  install -m 644 "$SRC_DIR/fail2ban/jail.d/qtvq.local" /etc/fail2ban/jail.d/qtvq.local

  # 自测正则：把示例日志喂给 fail2ban-regex。
  # ⚠️ 这一步是**硬门槛**：2026-10-11 实测发现，failregex 里带反斜杠转义时
  #   fail2ban 会静默丢弃该条（只显示 `Failregex: 0 total`，不报错）——
  #   也就是"装了 fail2ban 但一次都不封"。若不在这里拦住，就会长期处于假安全状态。
  echo ">> fail2ban 正则自测"
  TMPLOG=$(mktemp)
  # 样本必须与**真实日志格式**一致（含自定义的 ua_bad=/honeypot=/fake_crawler= 字段）
  printf '203.0.113.9 - - [11/Oct/2026:12:38:43 +0800] "GET / HTTP/1.1" 444 0 "-" "python-requests/2.31" ua_bad=1 honeypot=0 fake_crawler=0\n' >> "$TMPLOG"
  printf '203.0.113.10 - - [11/Oct/2026:12:38:44 +0800] "GET /.env HTTP/1.1" 444 0 "-" "curl/8" ua_bad=0 honeypot=1 fake_crawler=0\n' >> "$TMPLOG"
  printf '203.0.113.11 - - [11/Oct/2026:12:38:45 +0800] "GET / HTTP/1.1" 444 0 "-" "Googlebot/2.1" ua_bad=0 honeypot=0 fake_crawler=1\n' >> "$TMPLOG"
  printf '203.0.113.12 - - [11/Oct/2026:12:38:46 +0800] "GET /api/x HTTP/1.1" 429 10 "-" "curl/8"\n' >> "$TMPLOG"

  REGEX_RESULT=$(fail2ban-regex "$TMPLOG" /etc/fail2ban/filter.d/qtvq-nginx.conf 2>&1 || true)
  echo "$REGEX_RESULT" | grep -E 'Failregex:|Lines:' | sed 's/^/   /'
  if echo "$REGEX_RESULT" | grep -qE 'Failregex: [1-9]' && echo "$REGEX_RESULT" | grep -qE 'Matched: [1-9]'; then
    echo "   ✅ 正则生效（Failregex ≥1 且能匹配样本）"
  else
    echo "   ❌ 正则没生效 —— fail2ban 装了也不会封！请检查 filter 里是否用了反斜杠转义。" >&2
    rm -f "$TMPLOG"
    exit 1
  fi

  # 关键断言：**429 不能被蜜罐 filter 命中**。
  # 2026-10-26 的事故就是 429 被当成攻击信号 → 慢网重试把正常用户封 24h，
  # 而封禁是 DROP，用户只看到"连接超时"，连排查方向都会错。
  ONLY429=$(mktemp)
  printf '203.0.113.12 - - [11/Oct/2026:12:38:46 +0800] "GET /api/x HTTP/1.1" 429 10 "-" "curl/8"\n' >> "$ONLY429"
  HONEYPOT_RESULT=$(fail2ban-regex "$ONLY429" /etc/fail2ban/filter.d/qtvq-honeypot.conf 2>&1 || true)
  rm -f "$ONLY429"
  if echo "$HONEYPOT_RESULT" | grep -qE 'Matched: 0'; then
    echo "   ✅ 429 不会触发蜜罐封禁（限流与攻击已分开）"
  else
    echo "   ❌ 429 仍被蜜罐 filter 命中 —— 会把限流当攻击，造成慢网用户被误封。" >&2
    rm -f "$TMPLOG"
    exit 1
  fi
  rm -f "$TMPLOG"

  systemctl enable fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban
  sleep 2
  fail2ban-client status qtvq-nginx || true
fi

# ─────────────────────────── 3. 滥用告警 ───────────────────────────
echo ">> 安装告警脚本与 cron"
mkdir -p /opt/qtvq/tools/alerts
install -m 755 "$SRC_DIR/alerts/check-nginx-abuse.sh" /opt/qtvq/tools/alerts/check-nginx-abuse.sh

# ── 直连 SMTP 凭据（/etc/qtvq-alert.env）─────────────────────────────────────
# 告警**首选直连 SMTP**，所以这个文件决定"告警到底发不发得出去"。
# 规则：**已存在就保留**（重装绝不能覆盖或清空凭据 —— 那会让告警静默失效），
#       不存在且传了 --smtp-env 才写入，两者都没有则明确警告。
SMTP_ENV_DST=/etc/qtvq-alert.env
if [ -f "$SMTP_ENV_DST" ]; then
  chmod 600 "$SMTP_ENV_DST" 2>/dev/null || true
  echo "   已存在 $SMTP_ENV_DST —— 保留现有邮件凭据（不覆盖）"
elif [ -n "$SMTP_ENV_SRC" ] && [ -f "$SMTP_ENV_SRC" ]; then
  install -m 600 -o root -g root "$SMTP_ENV_SRC" "$SMTP_ENV_DST"
  echo "   已安装 $SMTP_ENV_DST（600 root）—— 告警将**直连 SMTP**，不依赖 Cloudflare"
else
  echo "   ⚠️ 没有 $SMTP_ENV_DST 且未传 --smtp-env："
  echo "      告警将**退回 HTTP 接口**（/api/ops/alert），即可用性重新依赖 Cloudflare Pages ——"
  echo "      而链路不通时恰恰最需要告警。装机时请带上：--smtp-env <含 SMTP_* 的文件>"
fi

if [ -n "$OPS_KEY" ]; then
  umask 077
  cat > /opt/qtvq/tools/alerts/alert.env <<EOF
# 由 install.sh 生成（权限 600）。QTVQ_OPS_KEY 是 Pages 侧的 OPS_ALERT_KEY 或 PAYMENT_ADMIN_KEY。
QTVQ_OPS_KEY=$OPS_KEY
QTVQ_ALERT_URL=https://qtvq.cn/api/ops/alert
QTVQ_ALERT_TO_LOG=/var/log/qtvq-alerts.log
EOF
  chmod 600 /opt/qtvq/tools/alerts/alert.env
  echo "   已写入 alert.env（600）"
else
  echo "   ⚠️ 未传 --ops-key：告警只记本地日志、不发邮件。补装：sudo bash $SCRIPT_NAME --ops-key '<key>'"
fi

touch /var/log/qtvq-alerts.log
chmod 640 /var/log/qtvq-alerts.log

CRON_LINE="*/5 * * * * /opt/qtvq/tools/alerts/check-nginx-abuse.sh >/dev/null 2>&1"
TMPCRON=$(mktemp)
crontab -l 2>/dev/null | grep -v 'check-nginx-abuse.sh' > "$TMPCRON" || true
echo "$CRON_LINE" >> "$TMPCRON"
crontab "$TMPCRON"
rm -f "$TMPCRON"
echo "   已加入 cron（每 5 分钟）"

# ─────────────────────────── 4. 自测提示 ───────────────────────────
cat <<'TIP'

================= 加固完成，请按下面 4 条自测 =================
1) 蜜罐路径应被断连（curl 报 "Empty reply from server"，HTTP 000）：
   curl -sS -o /dev/null -w '%{http_code}\n' https://qtvq.cn/.env

2) 恶意 UA 应被断连：
   curl -sS -o /dev/null -w '%{http_code}\n' -A 'python-requests/2.31' https://qtvq.cn/

3) 伪装爬虫（自称 Googlebot 但不是官方 IP）应被断连：
   curl -sS -o /dev/null -w '%{http_code}\n' -A 'Mozilla/5.0 (compatible; Googlebot/2.1)' https://qtvq.cn/

4) 正常浏览器仍然 200，且 fail2ban 状态可查：
   curl -sS -o /dev/null -w '%{http_code}\n' -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0' https://qtvq.cn/
   sudo fail2ban-client status qtvq-nginx
   tail -5 /var/log/qtvq-alerts.log

回滚（万一出问题）：
   sudo cp -a /root/qtvq-hardening-backup-<时间戳>/qtvq /etc/nginx/sites-enabled/qtvq
   sudo rm -f /etc/nginx/conf.d/qtvq-security.conf && sudo nginx -t && sudo systemctl reload nginx
   （备份目录：/root/qtvq-hardening-backup-<时间戳>/）
================================================================
TIP
