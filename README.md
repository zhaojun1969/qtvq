# 我心永恒 - Q问 (qtvq.cn)

情感避坑 + AI 智慧问答。设计文档见 `我心永恒-Q问.txt`。

## 功能概览

- **Q问**：文字/语音提问、再问一步、采纳建议、智能 mock/Workers AI；**24 小时最多 5 次免费提问**，超出可办月卡/季卡/年卡（对公汇款核实后不限次）
- **避坑大全**：50 条案例、场景/代价筛选、搜索、测验、行动卡 PNG、音视频弹层、高阶专题、提交教训
- **我的缘值**：缘认知匹配、缘分直线卡、解锁权益、定制报告下载、Q缘连线
- **Logo**：粉紫渐变圆环 + 艺术字「问」+ 右下 Q 点一捺

## 本地预览

```bash
npm run serve
# 浏览器打开 http://localhost:8080
```

含 AI 接口本地调试：

```bash
npm run dev
# http://localhost:8788
```

完整部署步骤见 **[DEPLOY.md](DEPLOY.md)**。  
多端 App / 小程序方案见 **[docs/MULTI-PLATFORM.md](docs/MULTI-PLATFORM.md)**。  
发布到 GitHub / Gitee 见 **[docs/GIT-PRIVATE.md](docs/GIT-PRIVATE.md)**、Gitee 首次 **[docs/GITEE-SETUP.md](docs/GITEE-SETUP.md)**（**务必私有**）。双推：`npm run git:push-all`  
上下文备份 OBS 见 **[docs/OBS.md](docs/OBS.md)**（`npm run context:upload` / `pnpm sync:obs`）。  
Cloudflare 动态数据 OSS 备份与降级见 **[docs/OSS-BACKUP.md](docs/OSS-BACKUP.md)**。

## Cloudflare 部署（API）

```bash
npm i -g wrangler
wrangler login
npm run deploy    # 部署到 qtvq-api.pages.dev
```

**API 地址：** https://qtvq-api.pages.dev  
**国内静态：** https://qtvq.cn（阿里云，见 [docs/DUAL-DEPLOY.md](docs/DUAL-DEPLOY.md)）

在控制台为 Pages 项目 **`qtvq-api`** 绑定 **Workers AI**（`AI`）、**KV**（`QTVQ_KV`）、**`PAYMENT_ADMIN_KEY`**。  
一键：`npm run deploy:full` · 收尾：`npm run post-deploy` · 静态同步：`tools/scripts/sync-static.sh`（Ubuntu）

## 项目结构

| 路径 | 说明 |
|------|------|
| index.html | 首页 Q问 |
| pitfalls.html | 避坑大全 |
| profile.html | 我的缘值 |
| js/data.js + data-extra.js | 50 条案例数据 |
| js/logo.js + layout.js | 统一 Logo |
| functions/api/chat.js | AI 接口 |
| functions/api/quota.js | 提问额度查询 |
| js/config.js | API 基址（qtvq.cn → qtvq-api） |
| functions/lib/cors.js | 跨域允许 qtvq.cn |
| functions/api/payment.js | 汇款登记与工作人员核实 |
| js/quota.js + js/subscribe.js | 额度逻辑与会员弹窗 |

## 品牌色

`#FF6B81` · `#6C5CE7`
