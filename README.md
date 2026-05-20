# 我心永恒 - Q问 (qtvq.cn)

情感避坑 + AI 智慧问答。设计文档见 `我心永恒-Q问.txt`。

## 功能概览

- **Q问**：文字/语音提问、再问一步、采纳建议、智能 mock/Workers AI；**24 小时最多 5 次免费提问**，超出可办月卡/季卡/年卡（对公汇款核实后不限次）
- **避坑大全**：50 条案例、场景/代价筛选、搜索、测验、行动卡 PNG、音视频弹层、高阶专题、提交教训
- **我的缘值**：缘认知匹配、缘分直线卡、解锁权益、定制报告下载、Q缘连线
- **Logo**：圆环 + ∞ + 正放 ? + 爱心 + Q，悬停时 ? 与爱心位置交换

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

## Cloudflare 部署

```bash
npm i -g wrangler
wrangler login
wrangler pages deploy .
```

**线上地址：** https://qtvq.pages.dev（绑定备案域见 [docs/DOMAIN-qtvq.cn.md](docs/DOMAIN-qtvq.cn.md)）

在控制台为 Pages 绑定 **Workers AI**（变量名 `AI`）、**KV**（`QTVQ_KV`）、**`PAYMENT_ADMIN_KEY`**。一键部署：`npm run deploy:full` · 收尾：`npm run post-deploy` · 打开控制台：`npm run dashboard`

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
| functions/api/payment.js | 汇款登记与工作人员核实 |
| js/quota.js + js/subscribe.js | 额度逻辑与会员弹窗 |

## 品牌色

`#FF6B81` · `#6C5CE7`
