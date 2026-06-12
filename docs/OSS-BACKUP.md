# Cloudflare 动态数据 → 阿里云 OSS 备份与降级

当 **qtvq-api.pages.dev**（Cloudflare）打不开或国内访问慢时，前端自动改读 **阿里云 OSS** 上的 JSON 备份；写入失败则暂存本地，恢复后自动同步。

---

## 架构

```
浏览器 (qtvq.cn)
  ├─ 1. 请求 Cloudflare API（8s 超时）
  └─ 2. 失败 → 读 OSS 备份 JSON（国内更快）
       POST 失败 → localStorage 离线队列 → 恢复后 flush
```

| 数据 | Cloudflare | OSS 备份路径 |
|------|------------|--------------|
| 公司汇款信息 | GET /api/payment | `backup/api/payment.json` |
| 健康检查 | GET /api/health | `backup/api/health.json` |
| 用户额度 | KV `client:*` | `backup/kv/clients/{clientId}.json` |
| 客服留言 | KV `contact:*` | `backup/kv/contacts/{id}.json` |
| 清单 | — | `backup/manifest.json` |

---

## 一、OSS 配置

`obs.env` 增加：

```ini
OSS_BACKUP_PREFIX=qtvq/backup/
# 公共读 URL（与 js/config.js BACKUP_ORIGIN 一致）
OSS_PUBLIC_BASE=https://qtvq.oss-cn-beijing.aliyuncs.com/qtvq/backup
```

**Bucket 策略建议：** 对 `qtvq/backup/api/*`、`qtvq/backup/kv/*` 设**公共读**（或走 CDN 域名），密钥仅用于 Workers 写入。

---

## 二、Cloudflare Workers 写入 OSS

在 **qtvq-api** Pages 项目 → Settings → Environment variables 添加（Production）：

| 变量 | 说明 |
|------|------|
| `OSS_ACCESS_KEY_ID` | 与 obs.env 相同 |
| `OSS_SECRET_ACCESS_KEY` | Secret |
| `OSS_ENDPOINT` | `oss-cn-beijing.aliyuncs.com` |
| `OSS_BUCKET` | `qtvq` |
| `OSS_BACKUP_PREFIX` | `qtvq/backup/` |

**自动备份时机：**

- 用户额度/会员变更（KV `saveRecord`）
- 客服留言提交
- 手动全量：`POST /api/backup-sync?adminKey=你的PAYMENT_ADMIN_KEY`

仅静态快照：

```bash
curl -X POST "https://qtvq-api.pages.dev/api/backup-sync?adminKey=密钥" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"static\"}"
```

---

## 三、本机发布初始快照

```powershell
cd d:\qtvq
npm run backup:publish
```

上传 `backup/snapshots/` 至 OSS。

---

## 四、前端降级（已实现）

- `js/api-fetch.js`：Cloudflare 优先，OSS 兜底
- `js/config.js`：`BACKUP_ORIGIN` 指向 OSS
- 离线队列：`localStorage` 键 `qtvq_offline_queue`

---

## 五、定时全量备份（推荐）

阿里云轻量机 crontab（每日 3:00）：

```bash
curl -s -X POST "https://qtvq-api.pages.dev/api/backup-sync?adminKey=$PAYMENT_ADMIN_KEY"
```

---

## 六、限制说明

| 能力 | 备份模式 |
|------|----------|
| 读汇款/额度 | ✅ OSS 快照 |
| AI 问答 | ⚠️ 本地模板答复，非真实 AI |
| 汇款/留言提交 | ⚠️ 离线暂存，需 CF 恢复后同步 |
| 工作人员核实 | ❌ 仍需 Cloudflare 或直连 KV |

AI 与核实流程依赖 Cloudflare；OSS 主要保障**国内用户可读、可留资、额度可查**。
