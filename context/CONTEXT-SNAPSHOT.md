# 我心永恒-Q问 · 项目上下文快照

生成用途：备份到 OBS，便于换机/协作时恢复背景。  
生成命令：`npm run context:build` / `npm run context:upload`

## 产品

- 名称：我心永恒 - Q问
- 域名：qtvq.cn（备案 京ICP备：19045082号，阿里云 Nginx 静态）
- API：https://qtvq-api.pages.dev（Cloudflare Pages Functions）
- 公司：我心永恒（北京）网络科技有限公司

## 线上架构（双域）

| 角色 | 地址 |
|------|------|
| 国内静态 | https://qtvq.cn → 阿里云 Ubuntu `/var/www/qtvq` |
| API + AI + KV | https://qtvq-api.pages.dev 项目名 **qtvq-api** |
| 工作人员核实 | https://qtvq-api.pages.dev/tools/verify-payment.html |

## Cloudflare

| 项 | 值 |
|----|-----|
| Account ID | bb7eb342a5cfde7c0a84cd9bd519a859 |
| Pages 项目（API） | qtvq-api |
| KV binding | QTVQ_KV |
| AI binding | AI（变量名必须为 AI） |
| 部署 | `npm run deploy`（需 Node 22+，API Token 或 wrangler login） |

## 核心业务规则

- 每 24 小时免费提问 5 次（滚动窗口）
- 「再问一步」不计入次数
- 超出：月卡 288 / 季卡 788 / 年卡 2888，对公汇款核实后不限次
- 收款账号见 `js/quota.js` → `COMPANY`

## 仓库与部署

- 本地路径：`d:\qtvq`
- GitHub：zhaojun1969/qtvq（私有）
- Gitee：待配置私有仓
- 静态同步（阿里云）：`bash tools/scripts/sync-static.sh`
- 密钥：`PAYMENT_ADMIN_KEY` 在 `.dev.vars`（**勿上传 OBS 公开桶**）

## 目录要点

| 路径 | 说明 |
|------|------|
| js/config.js | qtvq.cn → qtvq-api 跨域 API |
| functions/api/*.js | chat / quota / payment / health |
| apps/qtvq-uni/ | uni-app 多端 MVP |
| docs/DUAL-DEPLOY.md | 双域部署 |
| docs/MULTI-PLATFORM.md | App/小程序方案 |
| docs/CLOUDFLARE-TOKEN.md | API Token 权限 |
| docs/FIX-WORKERS-AI.md | AI fallback 修复 |
| docs/GIT-PRIVATE.md, GITEE-SETUP.md | 私有 Git |

## 已知待办

- Workers AI 绑定后消除 `fallback: true`
- Gitee 私有仓推送
- GitHub 仓库设为 Private

## 对话记录

同包内 `agent-transcript.txt`（已从 Cursor jsonl 导出并脱敏 Token/密码）。
