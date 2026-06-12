# Q问 多端应用

| 目录 | 说明 | 状态 |
|------|------|------|
| `qtvq-uni/` | uni-app MVP（三 Tab + 账户 + API） | ✅ 已初始化 |
| `../packages/api-client/` | 共享 API 协议（可选） | 待建 |

完整方案见 **[docs/MULTI-PLATFORM.md](../docs/MULTI-PLATFORM.md)**。

## API 基址（各端统一）

```
https://qtvq-api.pages.dev
```

## 首期目标

1. 微信小程序 MVP：Q问 + 额度 + 避坑 + 账户页  
2. 与 Web 共用 `clientId` 规则（`q_` 前缀 + 随机）  
3. PC / H5：微信 Native 在线支付 + 对公汇款核实并存；PC 微信扫码登录已上线  

微信配置见 `apps/qtvq-uni/docs/WEIXIN-ALIPAY.md`、`docs/WECHAT-OPEN-LOGIN.md`、`docs/PAYMENT-WECHAT-API.md`。

## 创建 uni-app 工程（本地）

需安装 [HBuilderX](https://www.dcloud.io/hbuilderx.html) 或 CLI：

```bash
npx degit dcloudio/uni-preset-vue#vite apps/qtvq-uni
cd apps/qtvq-uni
npm install
```

然后将 `manifest.json` 中微信小程序 `appid` 填为你的 AppID，在 `src/api/` 接入 chat/quota/payment。
