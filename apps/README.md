# Q问 多端应用

| 目录 | 说明 | 状态 |
|------|------|------|
| `qtvq-uni/` | uni-app MVP（三 Tab + API） | ✅ 已初始化 |
| `../packages/api-client/` | 共享 API 协议（可选） | 待建 |

完整方案见 **[docs/MULTI-PLATFORM.md](../docs/MULTI-PLATFORM.md)**。

## API 基址（各端统一）

```
https://qtvq-api.pages.dev
```

## 首期目标

1. 微信小程序 MVP：Q问 + 额度 + 避坑列表  
2. 与 Web 共用 `clientId` 规则（`q_` 前缀 + 随机）  
3. 支付首期仍展示对公账户（与 H5 一致），Native 支付在第 4 期

## 创建 uni-app 工程（本地）

需安装 [HBuilderX](https://www.dcloud.io/hbuilderx.html) 或 CLI：

```bash
npx degit dcloudio/uni-preset-vue#vite apps/qtvq-uni
cd apps/qtvq-uni
npm install
```

然后将 `manifest.json` 中微信小程序 `appid` 填为你的 AppID，在 `src/api/` 接入 chat/quota/payment。
