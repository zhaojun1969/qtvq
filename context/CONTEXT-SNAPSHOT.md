# 我心永恒-Q问 · 项目上下文快照

生成用途：备份到 OBS / Obsidian，便于换机/协作时恢复背景。  
生成命令：`pnpm sync:obs`（Obsidian + OSS）或 `npm run context:build`

最后更新：**2026-06-12**（PC 微信扫码登录已上线）

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
| 我的账户（PC） | https://qtvq.cn/account.html |
| 微信 OAuth 回调 | https://qtvq.cn/wechat-callback.html |

## Cloudflare

| 项 | 值 |
|----|-----|
| Account ID | bb7eb342a5cfde7c0a84cd9bd519a859 |
| Pages 项目（API） | qtvq-api |
| KV binding | QTVQ_KV |
| AI binding | AI（变量名必须为 AI） |
| 部署 | `npm run deploy:api-only` |
| 微信密钥上传 | `npm run wechat:secrets` |

## 微信生态 ID 对照

| 用途 | AppID / 值 |
|------|------------|
| 小程序 + 微信支付绑定 | `wx489fbca28401e4e0` |
| 开放平台网站应用「Q问」（PC 扫码登录） | `wxc4b560055c1978dc` |
| 微信支付商户号 | `1113936939` |
| 支付回调 | `https://qtvq-api.pages.dev/api/payment/wechat/notify` |
| PC 扫码 redirect_uri | `https://qtvq.cn/wechat-callback.html` |
| 业务域名校验文件 | `https://qtvq.cn/pO8yu0YU22.txt` |

## 已上线能力（2026-06）

- RAG 避坑检索 + GLM/Qwen/Llama 模型链
- 客服留言 `/api/contact` + SMTP 邮件通知
- 首页语音：阿里云 NLS `/api/speech`（`speechConfigured: true`）
- 页脚：帮助 / 隐私 / 客户端下载 / 邮箱弹窗
- 成功案例墙、两大核心服务卡片可点击
- uni-app MVP：`apps/qtvq-uni/`
- **账户体系**：手机号注册登录、KV 会话、打款核实状态查询（`account.html`）
- **PC 微信扫码登录**：开放平台网站应用 + `wechat-callback.html`（**已验证可用**）
- **忘记密码**：微信扫码验证后重置（PC）；客服可在核实页重置
- **微信 Native 在线支付**：PC 扫码支付 + 回调自动开通（`wechatPayConfigured: true`）
- 套餐：**月卡 ¥29 · 季卡 ¥79 · 年卡 ¥299**（对公汇款人工核实并存）

## 核心业务规则

- 每 24 小时免费提问 5 次（滚动窗口）
- 「再问一步」不计入次数
- 超出：办会员后不限次（在线微信支付或银行汇款 + 工作人员核实）
- 用户注册登录后可在 **我的账户** 查看会员与打款核实进度

## `/api/health` 关键字段

| 字段 | 期望（生产） |
|------|----------------|
| `wechatPayConfigured` | `true` |
| `wechatOpenLoginConfigured` | `true` |
| `wechatMpLoginConfigured` | 配 `WECHAT_MINI_APP_SECRET` 后为 `true` |
| `speechConfigured` | `true`（阿里云 NLS） |

## 仓库与部署

- 本地路径：`d:\qtvq`
- GitHub：zhaojun1969/qtvq（私有）
- 静态同步（阿里云）：`git pull && bash tools/scripts/sync-static.sh`
- 密钥：`.dev.vars` / Cloudflare Pages Secrets（**勿提交 Git**）
- 最近相关提交：`dd497e3`（微信回调页）、`e8d6486`（账户登录 + 套餐调价）

## 目录要点

| 路径 | 说明 |
|------|------|
| account.html / js/account.js / js/auth.js | PC 账户、登录、微信扫码 |
| wechat-callback.html | 开放平台 OAuth 回调（勿改作 account.html） |
| js/config.js | qtvq.cn → qtvq-api 跨域 API |
| js/subscribe.js / js/payment-wechat.js | 会员弹窗 + 微信 Native 支付 |
| functions/lib/auth-store.js | 用户、会话、微信绑定 |
| functions/lib/wechat-open.js | PC qrconnect / OAuth2 |
| functions/lib/wechat-pay.js | 微信支付 V3 |
| functions/api/auth.js / auth/me.js / auth/wechat/* | 登录注册 API |
| functions/api/payment/wechat/* | 在线支付下单 / 回调 / 查询 |
| verify/pO8yu0YU22.txt | 微信业务域名校验（同步到站点根目录） |
| docs/WECHAT-OPEN-LOGIN.md | PC 扫码登录运维 |
| docs/PAYMENT-WECHAT-API.md | 微信支付对接 |
| docs/SPEECH-ASR.md | 语音输入 |
| docs/MAIL-SMTP.md | 客服邮件 |
| docs/RAG.md | 避坑检索索引 |
| obsidian/ | Obsidian 文档库（`pnpm sync:obs` 同步） |

## 待办 / 可选

- 小程序 **微信一键登录**：配置 `WECHAT_MINI_APP_SECRET` → `npm run wechat:secrets`
- 开放平台绑定小程序 `wx489fbca28401e4e0`（UnionID 打通 PC 与小程序账号）
- 支付宝小程序 JSAPI（第 2 期）

## 对话记录

同包内 `agent-transcript.txt`（已从 Cursor jsonl 导出并脱敏 Token/密码）。
