# 我心永恒-Q问 · 项目上下文快照

生成用途：备份到 OBS / Obsidian，便于换机/协作时恢复背景。  
生成命令：`pnpm sync:obs`（Obsidian + OSS）或 `npm run context:build`

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
| 部署 | `npm run deploy:api-only` |

## 已上线能力（2026-06）

- RAG 避坑检索 + GLM/Qwen/Llama 模型链
- 客服留言 `/api/contact` + SMTP 邮件通知
- 首页语音：阿里云 NLS `/api/speech`（`speechConfigured: true`）
- 页脚：帮助 / 隐私 / 客户端下载 / 邮箱弹窗
- 成功案例墙、两大核心服务卡片可点击
- uni-app MVP：`apps/qtvq-uni/`

## 核心业务规则

- 每 24 小时免费提问 5 次（滚动窗口）
- 「再问一步」不计入次数
- 超出：月卡 28 / 季卡 78 / 年卡 288，对公汇款核实后不限次

## 仓库与部署

- 本地路径：`d:\qtvq`
- GitHub：zhaojun1969/qtvq（私有）
- 静态同步（阿里云）：`git pull && bash tools/scripts/sync-static.sh`
- 密钥：`.dev.vars` / Cloudflare Pages Secrets（**勿提交 Git**）

## 目录要点

| 路径 | 说明 |
|------|------|
| js/config.js | qtvq.cn → qtvq-api 跨域 API |
| js/voice-asr.js | 浏览器录音 + 阿里云 ASR |
| functions/api/*.js | chat / quota / payment / contact / speech / health |
| functions/lib/rag.js | RAG 向量检索 |
| obsidian/ | Obsidian 文档库（`pnpm sync:obs` 同步） |
| docs/SPEECH-ASR.md | 语音输入运维 |
| docs/MAIL-SMTP.md | 客服邮件 |
| docs/RAG.md | 避坑检索索引 |

## 对话记录

同包内 `agent-transcript.txt`（已从 Cursor jsonl 导出并脱敏 Token/密码）。
