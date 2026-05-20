# 我心永恒-Q问 · 项目上下文快照

生成用途：备份到 OBS，便于换机/协作时恢复背景。

## 产品

- 名称：我心永恒 - Q问
- 域名：qtvq.cn（备案 京ICP备：19045082号）
- 公司：我心永恒（北京）网络科技有限公司

## 线上环境

| 项 | 值 |
|----|-----|
| Pages 项目 | qtvq |
| 默认 URL | https://qtvq.pages.dev |
| Account ID | bb7eb342a5cfde7c0a84cd9bd519a859 |
| KV binding | QTVQ_KV |
| AI binding | AI (@cf/meta/llama-3-8b-instruct) |

## 核心业务规则

- 每 24 小时免费提问 5 次（滚动窗口）
- 「再问一步」不计入次数
- 超出：月卡 288 / 季卡 788 / 年卡 2888，对公汇款核实后不限次
- 收款账号见 `js/quota.js` → `COMPANY`

## 仓库与部署

- 本地路径：`d:\qtvq`
- Git：已 init，见 `GITHUB.md`
- 部署：`npm run deploy:full` / `npm run deploy`
- 密钥：`PAYMENT_ADMIN_KEY` 在 `.dev.vars`（勿上传 OBS 公开桶）

## 目录要点

| 路径 | 说明 |
|------|------|
| index.html / js/home.js | Q问首页 |
| pitfalls.html / js/pitfalls.js | 避坑大全 |
| profile.html / js/profile.js | 我的缘值 |
| functions/api/*.js | Cloudflare Pages Functions |
| js/quota.js, js/subscribe.js | 额度与会员 |
| tools/verify-payment.html | 工作人员核实 |
| DEPLOY.md, docs/DOMAIN-qtvq.cn.md | 部署与域名 |

## 域名待办

`qtvq.cn` 需在 Cloudflare DNS 配置 CNAME → `qtvq.pages.dev`（勿 URL 跳转）。

## 对话记录

完整 Cursor 对话导出见同包内 `agent-transcript.txt`（已脱敏，不含用户密码）。
