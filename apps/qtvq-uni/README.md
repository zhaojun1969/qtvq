# 我心永恒 Q问 · uni-app MVP

Android / iOS / 鸿蒙 / 微信 / 支付宝 / 抖音 共用工程。

## 环境

- Node.js 18+
- [HBuilderX](https://www.dcloud.io/hbuilderx.html)（推荐）或 CLI

```bash
cd apps/qtvq-uni
npm install
```

## 运行

```bash
npm run dev:h5              # 浏览器 H5
npm run dev:mp-weixin       # 微信小程序（需开发者工具）
npm run dev:mp-alipay       # 支付宝小程序
npm run dev:mp-toutiao      # 抖音小程序
npm run dev:app             # App
```

## 微信小程序配置

1. `src/manifest.json` → `mp-weixin.appid` 填入你的 AppID  
2. 微信公众平台 → 开发 → 开发管理 → 服务器域名 → request 合法域名：  
   `https://qtvq-api.pages.dev`

## API

与 Web 一致：`https://qtvq-api.pages.dev`

## 页面

| Tab | 说明 |
|-----|------|
| Q问 | 对话、额度、再问一步 |
| 避坑 | 精选案例 MVP |
| 缘值 | Q币/智慧/直线 + 额度 |

完整方案见 [docs/MULTI-PLATFORM.md](../../docs/MULTI-PLATFORM.md)
