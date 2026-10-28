# Q问 · 站点安全加固（反爬 / 防扫描 / 防饱和 / 告警）

> 2026-10-11 实施并**在线上验证通过**。所有配置都在本目录，通过 `install.sh` 一键安装。

## 一、已实现的能力

| 需求 | 实现 | 验证方式 |
| --- | --- | --- |
| 挡逆向爬虫/脚本库 | nginx `map $http_user_agent $qtvq_bad_ua` → `return 444` | `curl -A 'python-requests/2.31' https://qtvq.cn/` → **000**（断连） |
| **UA 伪造防护** | 自称 Baiduspider/Googlebot/bingbot/Sogou/360/Yandex 的请求，IP 必须在 `geo $qtvq_crawler_ok` 白名单里，否则 444 | `curl -A 'Googlebot/2.1' https://qtvq.cn/` → **000** |
| 蜜罐（黑客诱骗侵入） | `.git`/`.env`/`wp-admin`/`phpmyadmin`/`actuator`/`*.sql` 等路径 → 444 | `curl https://qtvq.cn/.env` → **000** |
| **fail2ban 封 24 小时** | 自写 filter（认 429/444 与 abuse 字段）+ 两个 jail（普通 20 次/10 分钟；蜜罐 3 次/小时），`bantime.increment` 指数加长 | `fail2ban-client status qtvq-nginx` 的 `Total failed` 会随恶意请求增长 |
| **饱和攻击防护** | `limit_req`（普通接口 10r/s、下单 3r/s、登录 1r/s）+ `limit_conn` 40，命中返回 **429** | 见下方"限速自测" |
| **告警** | `/opt/qtvq/tools/alerts/check-nginx-abuse.sh` 每 5 分钟统计 429/444/蜜罐，超阈值发邮件（走 `POST /api/ops/alert`） | `tail /var/log/qtvq-alerts.log` |
| 信息泄漏收紧 | `server_tokens off`；隐藏文件与 `.bak/.sql/.zip` 一律 444；`client_max_body_size 2m` | `curl -I https://qtvq.cn/` 不再有 nginx 版本 |
| 正常用户不受影响 | 静态页**不限速**；不封 curl/wget/Node（自己部署与体检在用） | 9 个页面 + 接口全部 200 |

## 二、两个必须知道的坑（都实际踩过）

### 1. failregex 里写反斜杠转义 → fail2ban **静默丢弃**该条

这是最危险的一类问题：**看起来配好了，实际一次都不会封**。

```
# 实测：这样写 → Failregex: 0 total（无任何报错）
failregex = ^<HOST> - - \[[^\]]+\] …

# 改成无反斜杠写法 → Failregex: 6 total，全部匹配
failregex = ^<HOST> - - .*" (?:429|444) [0-9]+
            ^<HOST> - - .*ua_bad=1
```

原因：fail2ban 把 `<HOST>` 替换成 host 正则后编译整条表达式，**编译失败的那条被静默跳过**。
所以本目录的 filter **刻意只用字面字符与 `.*`**：精度靠"我们自己的 abuse 日志字段"保证。

`install.sh` 现在把这一步做成**硬门槛**：正则没生效就直接 `exit 1`，不让假安全上线。

### 2. 别用内置的 `nginx-http-auth` / `nginx-botsearch`

内置 filter 主要认 401/403，而本项目用 429/444（444 是我们主动断连）。直接复用等于没配。

## 三、安装

```bash
# 1) 上传（在本机）
scp -r deploy/hardening admin@47.115.214.130:/tmp/qtvq-hardening

# 2) 在服务器上执行（--ops-key 用 Pages 的 OPS_ALERT_KEY 或 PAYMENT_ADMIN_KEY）
sudo bash /tmp/qtvq-hardening/install.sh --ops-key '<key>'

# 只做 nginx + 告警，不装 fail2ban：
sudo bash /tmp/qtvq-hardening/install.sh --ops-key '<key>' --no-fail2ban
```

`install.sh` 的安全设计：**先备份** → 改配置 → `nginx -t` **失败自动回滚**（绝不 reload 坏配置）→
幂等（重复执行不会重复插入片段）→ **不封 SSH**（fail2ban 只作用于 http/https，
本项目用 SSH 部署，封了会把自己锁在门外）。

## 四、自测（装完必跑）

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://qtvq.cn/.env                  # 期望 000
curl -sS -o /dev/null -w '%{http_code}\n' -A 'python-requests/2.31' https://qtvq.cn/  # 期望 000
curl -sS -o /dev/null -w '%{http_code}\n' -A 'Googlebot/2.1' https://qtvq.cn/   # 期望 000
curl -sS -o /dev/null -w '%{http_code}\n' -A 'Mozilla/5.0 Chrome/141' https://qtvq.cn/  # 期望 200
sudo fail2ban-client status qtvq-nginx
sudo fail2ban-regex /var/log/nginx/qtvq-abuse.log qtvq-nginx                     # Failregex ≥4
```

**限速自测**（会产生 429，属于预期）：

```bash
for i in $(seq 1 40); do curl -s -o /dev/null -w '%{http_code} ' https://qtvq.cn/api/quota; done; echo
# 前几次 200，之后出现 429 —— 说明漏桶生效
```

## 五、运维要点

- **看谁在被拦**：`sudo tail -f /var/log/nginx/qtvq-abuse.log`（每行末尾有 `ua_bad=/honeypot=/fake_crawler=` 判定字段）
- **看封禁**：`sudo fail2ban-client status qtvq-nginx`；解封 `sudo fail2ban-client set qtvq-nginx unbanip <IP>`
- **告警历史**：`tail -50 /var/log/qtvq-alerts.log`（每 5 分钟一行，即使没触发也记，便于回看"什么时候开始异常"）
- **⚠️ 自己把自己封了怎么办**：本机 IP 与业务方浏览器往往同源（同一出口 NAT）。
  若连续触发 20 次 429/444 会被封 24 小时。解封命令见上；必要时把办公 IP 加进
  `jail.d/qtvq.local` 的 `ignoreip`（**不要**把常用出口 IP 之外的内网段写进去）。
- **爬虫白名单维护**：`node tools/scripts/sync-crawler-ips.mjs --write` 拉取 Google 官方
  `googlebot.json` 覆盖 `qtvq-crawlers.geo.conf`（百度/360/神马未公开稳定列表，
  **宁可先拦**：收录若受影响，从 abuse 日志取真实 IP 核对后手工加段）。

## 六、回滚

```bash
sudo cp -a /root/qtvq-hardening-backup-<时间戳>/qtvq /etc/nginx/sites-enabled/qtvq
sudo rm -f /etc/nginx/conf.d/qtvq-security.conf
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl stop fail2ban && sudo systemctl disable fail2ban
crontab -l | grep -v check-nginx-abuse.sh | crontab -
```

## 七、还没做（下一步）

- **联系方式二次限流**：登录后「点击查看」完整号码 + 每日次数上限（需要先确认现有联系方式展示入口）
- **蜜罐水印**：给联系方式埋唯一标记，泄漏后可追溯来源
- **违法言论检查加强**：广告法违禁词、涉政/淫秽走阿里云内容安全（持牌服务），本地词表只做兜底
- **阿里云 Green 图片审核 + 本地 OCR + 敏感词三重校验**（图片类内容）
