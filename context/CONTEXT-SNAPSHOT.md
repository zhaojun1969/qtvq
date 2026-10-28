# 我心永恒-Q问 · 项目上下文快照



生成用途：备份到 OBS / Obsidian，便于换机/协作时恢复背景。  

生成命令：`pnpm sync:obs`（Obsidian + OSS）或 `npm run context:build`



最后更新：**2026-06-13**（四端小程序同 UI：微信 / 支付宝 / 抖音 / 小红书）



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

- **账户体系**：手机号注册登录、KV 会话、打款核实状态查询（`account.html`）

- **PC 微信扫码登录**：开放平台网站应用 + `wechat-callback.html`（已验证可用）

- **忘记密码**：微信扫码验证后重置（PC）；小程序「忘记密码」Tab + 微信验证；客服可在核实页重置

- **微信 Native 在线支付**：PC 扫码支付 + 回调自动开通（`wechatPayConfigured: true`）

- 套餐：**月卡 ¥29 · 季卡 ¥79 · 年卡 ¥299**（在线支付 + 对公汇款人工核实并存）



## uni-app 小程序 MVP（`apps/qtvq-uni/`）



**当前体验版版本：`1.0.6`**（`manifest.json` + `src/data/constants.js` → `APP_VERSION`）



| Tab / 页 | 要点 |

|----------|------|

| **Q问** | 10 条示例问题、热点、对话、语音（PCM 16k）、会员入口；顶栏 Logo + 品牌居中 |

| **避坑** | **10 条**精选案例（`pitfalls-sample.json`），**页面原生滚动**，可滚到底 |

| **缘值** | Q币/会员/菜单；`scroll-view` + `pageHeightPx` |

| **办理会员** | 微信 JSAPI 直接扣款 + 扫码可选；静态码 + 对公 + **提交汇款核实** |

| **我的账户** | 微信一键登录、忘记密码、改密、打款状态 |



**布局规范（Tab 页）：**



- 勿用 `100vh`；用 `uni.getSystemInfoSync().windowHeight` → `pageHeightPx`（`src/utils/navBar.js`）

- 顶栏 `BrandNavBar.vue` 随页面流式布局（非 fixed，避免挡点击）

- Q问 空态：欢迎语 + 示例 **合并为一个 scroll-view**；输入区高度动态测量

- 微信小程序 `input`：**固定 height + line-height**，勿仅用 padding（账户页、办理会员页已修）



**编译上传：**



```bash

npm run build:mp-weixin   # 根目录或 apps/qtvq-uni

# 导入 apps/qtvq-uni/dist/build/mp-weixin

# 看 apps/qtvq-uni/LAST-BUILD.txt

```



文档：`apps/qtvq-uni/docs/MULTI-MINI-PROGRAM.md`（四端）、`WEIXIN-ALIPAY.md`、`NAV-DESIGN.md`

**四端编译：** `npm run build:mp-all` → `dist/build/mp-weixin|mp-alipay|mp-toutiao|mp-xhs`



## 核心业务规则



- 每 **24 小时**免费提问 **5 次**（滚动窗口）

- 「再问一步」不计入次数

- 会员：**30 / 90 / 365 天**不限次；到期自动恢复免费额度（实时判断 `activeUntil`，无定时任务）

- 续费：未到期时新时长 **叠在原有到期日之后**

- 汇款：核实通过时刻起算有效期（非打款时刻）

- 详见 **[docs/MEMBERSHIP-RULES.md](../docs/MEMBERSHIP-RULES.md)**



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

- 小程序更新：**微信开发者工具上传体验版**（非 sync-static）

- API 改动：`npm run deploy:api-only`



## 目录要点



| 路径 | 说明 |

|------|------|

| account.html / js/account.js / js/auth.js | PC 账户、登录、微信扫码 |

| wechat-callback.html | 开放平台 OAuth 回调 |

| js/config.js | qtvq.cn → qtvq-api 跨域 API |

| js/subscribe.js / js/payment-wechat.js | 会员弹窗 + 微信 Native 支付 |

| functions/lib/quota-store.js | 额度、会员 `activeUntil`、汇款核实 |

| functions/lib/auth-store.js | 用户、会话、微信绑定 |

| functions/lib/wechat-pay.js | 微信支付 V3 |

| functions/api/payment/wechat/* | 下单 / 回调 / 查询 |

| apps/qtvq-uni/src/pages/* | 小程序页面 |

| apps/qtvq-uni/src/utils/navBar.js | Tab 页高度 `pageHeightPx` / `bodyHeightPx` |

| apps/qtvq-uni/src/data/pitfalls-sample.json | 小程序避坑 10 条 |

| docs/MEMBERSHIP-RULES.md | 会员开通/到期/续费规则 |

| docs/PAYMENT-WECHAT-API.md | 微信支付对接 |

| `apps/qtvq-uni/docs/MULTI-MINI-PROGRAM.md` | 微信/支付宝/抖音/小红书同 UI 编译与发布 |
| docs/WECHAT-MINI-LOGIN.md | 小程序 Secret + UnionID |

| docs/WECHAT-OPEN-LOGIN.md | PC 扫码登录 |

| obsidian/ | Obsidian 文档库（`pnpm sync:obs`） |



## 待办 / 可选



- 开放平台绑定小程序 `wx489fbca28401e4e0`（UnionID 打通 PC 与小程序账号）

- 支付宝小程序 JSAPI（第 2 期）

- 会员到期主动提醒（当前仅被动显示有效期）



## 对话记录



同包内 `agent-transcript.txt`（`npm run context:build` 从 Cursor jsonl 导出并脱敏）。

